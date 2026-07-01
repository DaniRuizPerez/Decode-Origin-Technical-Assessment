/**
 * Documentation Reviewer agent — proposes section-level edits to the EXISTING
 * docs, grounded in both the release's changes and the retrieved doc evidence.
 *
 * ARCHITECTURE — hybrid "retrieval-driven extractive baseline + grounded loop":
 *
 *   1. For each substantive change/theme we query the hybrid retriever with the
 *      change summary + its components. The top retrieved chunk names the exact
 *      doc + section a suggestion should target — retrieval *is* the localization
 *      step (chunks are section-sized, see lib/rag/chunk). This produces the
 *      deterministic EXTRACTIVE baseline: a `DocUpdate` per (change, top chunk),
 *      citing the change's real `sourceIds` and the real `retrievedChunkId`.
 *   2. That baseline is wrapped in `groundedGenerate`, so every suggestion's
 *      `sources[]` is verified against the real artifact-id set (and repaired once
 *      with a real provider). Offline (MockProvider) the baseline is returned and
 *      verified verbatim — a clean no-op pass.
 */

import {
  DocUpdateSchema,
  type Change,
  type ChangeSet,
  type DocUpdate,
  type LLMProvider,
  type ReleasePlan,
  type RetrievedChunk,
} from "@/lib/schemas";
import { z } from "zod";

import { groundedGenerate } from "@/lib/grounding";
import type { Retriever } from "@/lib/rag";

/**
 * Change types that warrant a documentation review. Pure `docs` changes are the
 * doc edits themselves (nothing to suggest), and `test`/`chore` work is internal
 * plumbing a user-facing doc never describes — including them would generate noise
 * the faithfulness check can't catch (a grounded-but-pointless suggestion).
 * Behavior-affecting types (feature/fix/breaking/refactor/perf/security/deps) are
 * the ones whose semantics a doc may now misstate.
 */
const REVIEWABLE_TYPES = new Set<Change["type"]>([
  "feature",
  "fix",
  "breaking",
  "refactor",
  "perf",
  "security",
  "deps",
]);

/**
 * Docs we never *suggest editing* even when they rank highly — meta/reference docs
 * a release never updates. `release-notes.md` is the project's own auto-generated
 * changelog (it contains the very changes we describe, so a "update the release
 * notes" suggestion is circular). `alternatives.md` is FastAPI's "Alternatives,
 * Inspiration & Comparisons" page — it documents *other* projects and is never a
 * target for a code change, yet its comparison sections otherwise dominate lexical
 * (non-semantic) retrieval and produce off-target picks. `_llm-test.md` is a
 * fixture/probe file. Excluding these from the *target* (not the index) keeps
 * suggestions actionable while leaving the retriever's ranking untouched.
 */
const NON_TARGET_DOCS = new Set<string>([
  "release-notes.md",
  "alternatives.md",
  "_llm-test.md",
]);

/**
 * How many chunks to pull per change. We retrieve a few because the single top
 * hit is often the circular `release-notes.md`; pulling a small window lets us
 * skip non-target docs and still land on the real tutorial/guide section. Kept
 * small so the suggestion stays focused on the most relevant place.
 */
const RETRIEVE_K = 4;

/**
 * Build the retrieval query for a change: its summary, its details, and its
 * components, concatenated.
 *
 * WHY include `details` (not just summary + components): the summary is terse
 * prose while `details` carries the high-signal *identifiers* a doc actually uses
 * (`include_router`, `router.routes`, `convert_underscores`). Those identifiers
 * are what let BM25 pin the exact tutorial section — a summary-only query for the
 * routing refactor drifts to a topically-adjacent doc (e.g. WSGI "applications"),
 * whereas adding the identifiers lands squarely on the include_router tutorial.
 * Components add the topical hook for the dense signal.
 */
function queryForChange(change: Change): string {
  return [change.summary, change.details, ...change.components]
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * Code identifiers the change touches — backticked tokens plus snake_case/dotted
 * names from its summary + details (e.g. `include_router`, `router.routes`,
 * `convert_underscores`). These are the distinctive strings a *relevant* doc section
 * would also contain.
 */
function changeIdentifiers(change: Change): string[] {
  const text = `${change.summary} ${change.details}`;
  const ids = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) ids.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9]*[_.][a-zA-Z0-9_.]+\b/g)) {
    ids.add(m[0].toLowerCase());
  }
  return [...ids];
}

/**
 * Relevance gate: does the retrieved section actually reference something the change
 * touches? Non-semantic (hashing) retrieval will always return *some* top hit, so we
 * only propose an edit when the section literally contains one of the change's code
 * identifiers. A change with no distinctive identifier (pure prose) can't be
 * confidently grounded, so we decline — keeping doc suggestions high-precision
 * ("say nothing" beats "edit the wrong doc").
 */
function mentionsChange(chunk: RetrievedChunk, change: Change): boolean {
  const ids = changeIdentifiers(change);
  if (ids.length === 0) return false;
  const haystack = chunk.text.toLowerCase();
  return ids.some((id) => haystack.includes(id));
}

/**
 * Turn a change + its grounding chunk into a concrete edit suggestion. The phrasing
 * is action-oriented and names the section so a maintainer can act on it directly;
 * the change summary states *what* changed so the suggestion is self-contained.
 */
function suggestionFor(change: Change, chunk: RetrievedChunk): string {
  return (
    `Update the "${chunk.section}" section in ${chunk.docPath} to reflect: ` +
    `${change.summary}.`
  );
}

/**
 * A concrete proposed edit of the section, for the before→after diff. The change's
 * `details` (its behavior/identifiers) — or its `summary` as a fallback — are woven
 * in as a new paragraph so the proposed section reads like updated documentation,
 * not a change-log note: no "> Doc update:" marker and no inline PR citation
 * (grounding lives on the DocUpdate's `sources[]`). The keyed path can replace this
 * with a fuller integrated rewrite.
 */
function proposeEdit(sectionText: string, change: Change): string {
  const addition = (change.details || change.summary).trim();
  const sentence = /[.!?]$/.test(addition) ? addition : `${addition}.`;
  return `${sectionText.trimEnd()}\n\n${sentence}`;
}

/** Wrap the doc-updates list so the provider returns a single structured value. */
const DocUpdatesDraftSchema = z.object({
  docUpdates: z.array(DocUpdateSchema),
});

const DOC_REVIEWER_SYSTEM =
  "You are a documentation reviewer. Given a code change and the existing doc " +
  "section it relates to, propose a concrete edit to that section. You never " +
  "invent doc paths or sources: every suggestion must reference the retrieved " +
  "chunk it is based on and carry the change's source ids.";

/**
 * Review the existing documentation against a release and propose section-level
 * updates, each grounded in a retrieved chunk and the change's source ids.
 *
 * Flow:
 *  1. For each reviewable change, query the retriever and pick the best chunk
 *     whose doc is an eligible *target* (skipping circular/non-doc files).
 *  2. Emit one `DocUpdate` per (change, chunk), deduplicated by docPath+section so
 *     several routing changes that point at the same section collapse to one
 *     suggestion (the strongest-cited one).
 *  3. Wrap the list in `groundedGenerate` to verify/repair every suggestion's
 *     `sources[]` in the loop.
 *
 * @param changeSet the digester's grounded changes
 * @param plan      the planner's output (reserved for future theme-level queries;
 *                  accepted now so the coordinator's call site is stable)
 * @param retriever a hybrid retriever already indexed over the existing docs
 *                  (typically `buildRetriever(getConnector().loadDocs())`)
 * @param provider  the LLM provider (MockProvider offline)
 */
/**
 * The Documentation Reviewer's output: the suggestions plus the retrieval evidence
 * (the actual chunks, carrying their real RRF scores + bm25/dense signals) that
 * grounds them — so the pipeline can surface honest evidence in the UI instead of a
 * re-derived stub.
 */
export interface DocReviewResult {
  updates: DocUpdate[];
  retrieved: RetrievedChunk[];
}

export async function reviewDocs(
  changeSet: ChangeSet,
  plan: ReleasePlan,
  retriever: Retriever,
  provider: LLMProvider,
): Promise<DocReviewResult> {
  // `plan` is part of the agent contract (the coordinator passes the full plan);
  // referenced here to keep the signature honest without an unused-param lint.
  void plan;

  const reviewable = changeSet.changes.filter((c) =>
    REVIEWABLE_TYPES.has(c.type),
  );

  // Deduplicate by docPath+section. First write wins; because `reviewable` is in
  // the digester's order (breaking/features first in a well-formed plan) the
  // surviving suggestion is the highest-priority change that targets a section.
  const byDocSection = new Map<string, DocUpdate>();
  // The chunk chosen for each surviving suggestion, keyed by id, so the pipeline
  // can surface the real retrieval evidence (RRF score + bm25/dense signals).
  const chosenChunks = new Map<string, RetrievedChunk>();

  for (const change of reviewable) {
    const hits = await retriever.retrieve(queryForChange(change), RETRIEVE_K);

    // Pick the highest-ranked chunk whose doc is an eligible target. Falls back
    // to nothing (skip the change) if every hit is a non-target doc, rather than
    // emit a circular "edit the release notes" suggestion.
    const chunk = hits.find((h) => !NON_TARGET_DOCS.has(h.docPath));
    if (!chunk) continue;

    // Relevance gate: only propose an edit when the section actually references an
    // identifier the change touches — otherwise a non-semantic top hit is likely
    // off-target. We'd rather say nothing than suggest editing the wrong doc.
    if (!mentionsChange(chunk, change)) continue;

    const key = `${chunk.docPath} ${chunk.section}`;
    if (byDocSection.has(key)) continue;

    chosenChunks.set(chunk.id, chunk);
    byDocSection.set(
      key,
      DocUpdateSchema.parse({
        docPath: chunk.docPath,
        section: chunk.section,
        suggestion: suggestionFor(change, chunk),
        retrievedChunkId: chunk.id,
        // Grounding: cite the change's real source ids. The retrieved chunk is
        // the doc-side evidence (retrievedChunkId); sources are the change-side.
        sources: change.sourceIds,
        // A concrete before→after diff target: the current section with a grounded
        // note inserted (offline). The keyed prompt can replace it with a rewrite.
        proposedText: proposeEdit(chunk.text, change),
      }),
    );
  }

  const fallback = [...byDocSection.values()];

  const result = await groundedGenerate({
    provider,
    request: {
      agent: "doc-reviewer",
      system: DOC_REVIEWER_SYSTEM,
      prompt:
        "Propose documentation updates. For each changed area, suggest a concrete " +
        "edit to the most relevant existing doc section. Reference the retrieved " +
        "chunk and cite the change's source ids.",
      schema: DocUpdatesDraftSchema,
      fallback: { docUpdates: fallback },
    },
    extractItems: (value) => value.docUpdates,
    // The universe of legitimate citations: every artifact id any change carries.
    validSourceIds: new Set(
      changeSet.changes.flatMap((c) => c.sourceIds),
    ),
  });

  return { updates: result.value.docUpdates, retrieved: [...chosenChunks.values()] };
}
