/**
 * Release Writer agent — turns a grounded `ChangeSet` + `ReleasePlan` into three
 * human-facing artifacts: a categorized changelog, internal release notes, and
 * customer release notes.
 *
 * ARCHITECTURE — hybrid "extractive baseline + grounded enrichment":
 *
 *   1. A deterministic, EXTRACTIVE baseline is computed first (the `*Fallback`
 *      builders below). It is assembled directly from the change set / plan, so
 *      every line it emits already cites real artifact ids carried on the
 *      changes — it cannot hallucinate. Offline (MockProvider) this baseline *is*
 *      the returned output.
 *   2. Each baseline is then handed to `groundedGenerate` as the request
 *      `fallback`. With a real LLM that call rewrites the baseline more fluently;
 *      with the MockProvider it returns the baseline verbatim. Either way the
 *      result passes through the in-loop faithfulness verifier, which checks every
 *      item's `sources[]` against the real id set and repairs a bad citation once.
 *
 * WHY three separate `groundedGenerate` calls (not one over the whole bundle):
 * the changelog, internal notes, and customer notes have different audiences and
 * prompts, and verifying each independently keeps a faithfulness failure in one
 * artifact from poisoning the others. They share one `validSourceIds` set.
 *
 * The internal vs. customer split is the product's core differentiation:
 *   - INTERNAL notes are for maintainers: explicit risk level + reasons, affected
 *     systems, migration-relevant detail — they may name PRs/tickets.
 *   - CUSTOMER notes are benefit-oriented and written in plain language with NO
 *     internal identifiers in the body (no `pr:`/`commit:`/`ticket:` strings, no
 *     `#1234` PR numbers). `sources[]` is still populated for traceability, but
 *     the prose a customer reads never leaks internal machinery.
 */

import {
  ChangelogEntrySchema,
  NoteSectionSchema,
  type Change,
  type ChangeSet,
  type ChangelogEntry,
  type LLMProvider,
  type NoteSection,
  type ReleasePlan,
} from "@/lib/schemas";
import { z } from "zod";

import { groundedGenerate } from "@/lib/grounding";

/** The Writer's structured output: one bundle of three grounded artifact lists. */
export interface WriterOutput {
  changelog: ChangelogEntry[];
  internalReleaseNotes: NoteSection[];
  customerReleaseNotes: NoteSection[];
}

/* ============================================================================
 * Category mapping (changelog grouping)
 * ========================================================================== */

/**
 * Human-facing changelog category for a change. `isBreaking` wins over the raw
 * type so a breaking feature/refactor still lands under "Breaking Changes" — the
 * thing a reader scans for first. Otherwise we map the conventional change type
 * to a conventional changelog heading.
 */
function categoryOf(change: Change): string {
  if (change.isBreaking || change.type === "breaking") return "Breaking Changes";
  switch (change.type) {
    case "feature":
      return "Features";
    case "fix":
      return "Fixes";
    case "perf":
      return "Performance";
    case "security":
      return "Security";
    case "refactor":
      return "Refactors";
    case "deps":
      return "Dependencies";
    case "docs":
      return "Documentation";
    case "test":
      return "Tests";
    case "chore":
      return "Chores";
    default:
      // Exhaustive over the current enum; the default keeps us forward-compatible
      // if a new ChangeType is added without crashing the writer.
      return "Other";
  }
}

/**
 * Stable display order for changelog categories. A release reader expects
 * breaking changes and features at the top and housekeeping at the bottom;
 * encoding the order here (rather than relying on change input order) makes the
 * changelog deterministic and well-organized regardless of how the digester
 * happened to order its changes.
 */
const CATEGORY_ORDER = [
  "Breaking Changes",
  "Features",
  "Fixes",
  "Performance",
  "Security",
  "Refactors",
  "Dependencies",
  "Documentation",
  "Tests",
  "Chores",
  "Other",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  // Unknown categories sort after all known ones, but before nothing — stable.
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/* ============================================================================
 * Internal-identifier scrubbing (customer notes only)
 * ========================================================================== */

/**
 * Namespaced artifact ids (`pr:15745`, `commit:8e1d774`, `ticket:FAPI-1003`) and
 * bare PR references (`#15745`, `(#15745)`). Customer-facing prose must contain
 * none of these. WHY scrub defensively even though we author the text from the
 * change *summary*: a digester summary harvested from a squash-merge subject can
 * carry a trailing `(#1234)`, and the contract for customer notes is an explicit
 * "no internal identifiers in the body" — so we enforce it rather than trust the
 * upstream text to be clean.
 */
const INTERNAL_ID_RE = /\b(?:pr|commit|ticket):[A-Za-z0-9._-]+/gi;
const PR_NUMBER_RE = /\(?#\d+\)?/g;

/** Remove any internal identifier from customer-facing prose and tidy whitespace. */
function scrubInternalIds(text: string): string {
  return text
    .replace(INTERNAL_ID_RE, "")
    .replace(PR_NUMBER_RE, "")
    // Collapse the whitespace / dangling punctuation a removal can leave behind
    // (e.g. "underscore headers (#15589)." → "underscore headers.").
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/* ============================================================================
 * Deterministic extractive baselines
 * ========================================================================== */

/**
 * EXTRACTIVE changelog baseline: one entry per change, grouped by category.
 *
 * `text` is the change's own summary (extractive — never invented), `sources` is
 * the change's `sourceIds` verbatim (the grounding guarantee). Entries are sorted
 * by category rank then input order so the changelog reads top-down by importance
 * and is deterministic.
 */
function buildChangelogFallback(changeSet: ChangeSet): ChangelogEntry[] {
  const entries = changeSet.changes.map((change) =>
    ChangelogEntrySchema.parse({
      category: categoryOf(change),
      text: change.summary,
      sources: change.sourceIds,
    }),
  );

  // Stable sort: category rank is the only key, so changes within a category keep
  // their original (digester) order.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        categoryRank(a.entry.category) - categoryRank(b.entry.category) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

/** All source ids cited across a set of changes, de-duplicated, in first-seen order. */
function collectSources(changes: Change[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const change of changes) {
    for (const id of change.sourceIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
}

/**
 * EXTRACTIVE internal-notes baseline. Four sections, each grounded by the change
 * ids relevant to it:
 *
 *  - Overview        — what shipped, headline counts; sources = every change.
 *  - Affected systems — from `plan.affectedSystems`; sources = the changes whose
 *    components intersect those systems (so the section is traceable to evidence).
 *  - Risk            — `plan.risk.level` + the explicit reasons; sources = the
 *    breaking/highest-signal changes that drove the risk.
 *  - Notable changes — the breaking + feature changes spelled out for maintainers,
 *    with their details; sources = those changes.
 *
 * Sections with no backing change are omitted rather than emitted ungrounded — an
 * empty `sources` would (correctly) be flagged by the faithfulness verifier.
 */
function buildInternalNotesFallback(
  changeSet: ChangeSet,
  plan: ReleasePlan,
): NoteSection[] {
  const { changes } = changeSet;
  const sections: NoteSection[] = [];

  // --- Overview -------------------------------------------------------------
  if (changes.length > 0) {
    const breakingCount = changes.filter(
      (c) => c.isBreaking || c.type === "breaking",
    ).length;
    const featureCount = changes.filter((c) => c.type === "feature").length;
    const fixCount = changes.filter((c) => c.type === "fix").length;
    const counts = [
      breakingCount > 0 ? `${breakingCount} breaking` : null,
      featureCount > 0
        ? `${featureCount} feature${featureCount === 1 ? "" : "s"}`
        : null,
      fixCount > 0 ? `${fixCount} fix${fixCount === 1 ? "" : "es"}` : null,
    ].filter((s): s is string => s !== null);

    const overview =
      `This release contains ${changes.length} change${changes.length === 1 ? "" : "s"}` +
      (counts.length > 0 ? ` (${counts.join(", ")}).` : ".") +
      (changeSet.unlinkedArtifactIds.length > 0
        ? ` ${changeSet.unlinkedArtifactIds.length} artifact(s) could not be tied to a ticket and are surfaced as incomplete information.`
        : "");

    sections.push(
      NoteSectionSchema.parse({
        heading: "Overview",
        body: overview,
        sources: collectSources(changes),
      }),
    );
  }

  // --- Affected systems -----------------------------------------------------
  if (plan.affectedSystems.length > 0) {
    // Ground the section in the changes that actually touch the listed systems,
    // matching on the change's `components`. Falls back to all changes if the
    // digester didn't populate components (so the section is never ungrounded).
    const systemSet = new Set(plan.affectedSystems.map((s) => s.toLowerCase()));
    const relevant = changes.filter((c) =>
      c.components.some((comp) => systemSet.has(comp.toLowerCase())),
    );
    const backing = relevant.length > 0 ? relevant : changes;
    sections.push(
      NoteSectionSchema.parse({
        heading: "Affected systems",
        body: `Systems touched by this release: ${plan.affectedSystems.join(", ")}.`,
        sources: collectSources(backing),
      }),
    );
  }

  // --- Risk -----------------------------------------------------------------
  // The risk section MUST carry the explicit reasons (a spec success criterion).
  const riskBacking = changes.filter(
    (c) => c.isBreaking || c.type === "breaking" || c.type === "security",
  );
  const riskSources = collectSources(
    riskBacking.length > 0 ? riskBacking : changes,
  );
  if (riskSources.length > 0) {
    const reasons =
      plan.risk.reasons.length > 0
        ? plan.risk.reasons.map((r) => `- ${r}`).join("\n")
        : "- No specific risk reasons were recorded.";
    sections.push(
      NoteSectionSchema.parse({
        heading: "Risk",
        body: `Risk level: ${plan.risk.level.toUpperCase()}.\n\nReasons:\n${reasons}`,
        sources: riskSources,
      }),
    );
  }

  // --- Notable changes ------------------------------------------------------
  // Breaking + feature changes are what maintainers most need spelled out, with
  // the migration-relevant detail. Each bullet is grounded by its own change.
  const notable = changes.filter(
    (c) => c.isBreaking || c.type === "breaking" || c.type === "feature",
  );
  if (notable.length > 0) {
    const body = notable
      .map((c) => {
        const detail = c.details ? ` ${c.details}` : "";
        return `- ${c.summary}.${detail}`;
      })
      .join("\n");
    sections.push(
      NoteSectionSchema.parse({
        heading: "Notable changes",
        body,
        sources: collectSources(notable),
      }),
    );
  }

  return sections;
}

/**
 * EXTRACTIVE customer-notes baseline. Benefit-oriented sections derived from the
 * customer-relevant changes (features and breaking changes), in PLAIN language:
 *
 *  - "What's new"      — features, phrased as benefits.
 *  - "Action required" — breaking changes, phrased as what the customer must do.
 *
 * The body is scrubbed of every internal identifier (`scrubInternalIds`), so a
 * customer never sees a PR number or artifact id — while `sources[]` still carries
 * those ids for internal traceability and the faithfulness verifier.
 */
function buildCustomerNotesFallback(changeSet: ChangeSet): NoteSection[] {
  const { changes } = changeSet;
  const sections: NoteSection[] = [];

  // Features that are NOT breaking. A change can be `type: "feature"` yet flagged
  // `isBreaking`; those belong under "Action required", not "What's new".
  const features = changes.filter((c) => c.type === "feature" && !c.isBreaking);
  const breaking = changes.filter((c) => c.isBreaking || c.type === "breaking");

  // --- What's new (features) ------------------------------------------------
  if (features.length > 0) {
    const body = features
      .map((c) => `- ${scrubInternalIds(c.summary)}.`)
      .join("\n");
    sections.push(
      NoteSectionSchema.parse({
        heading: "What's new",
        body: scrubInternalIds(body),
        sources: collectSources(features),
      }),
    );
  }

  // --- Action required (breaking changes) -----------------------------------
  if (breaking.length > 0) {
    const body = breaking
      .map((c) => `- ${scrubInternalIds(c.summary)}.`)
      .join("\n");
    sections.push(
      NoteSectionSchema.parse({
        heading: "Action required",
        body:
          "Some changes in this release may require updates to your integration:\n" +
          scrubInternalIds(body),
        sources: collectSources(breaking),
      }),
    );
  }

  // If a release is pure fixes/chores with nothing customer-notable, emit a
  // single grounded reliability note so the customer artifact is never empty
  // while still citing real evidence.
  if (sections.length === 0 && changes.length > 0) {
    const fixes = changes.filter((c) => c.type === "fix");
    const backing = fixes.length > 0 ? fixes : changes;
    sections.push(
      NoteSectionSchema.parse({
        heading: "Improvements and fixes",
        body: "This release includes reliability improvements and bug fixes.",
        sources: collectSources(backing),
      }),
    );
  }

  return sections;
}

/* ============================================================================
 * Grounded generation wiring
 * ========================================================================== */

// Schemas for the three generations. We wrap each artifact list in a tiny object
// so the provider returns a single structured value (and so the MockProvider can
// re-parse it on the same path the real provider validates model output).
const ChangelogDraftSchema = z.object({
  changelog: z.array(ChangelogEntrySchema),
});
const NotesDraftSchema = z.object({ notes: z.array(NoteSectionSchema) });

const WRITER_SYSTEM =
  "You are a release-documentation writer. You ONLY restate information present " +
  "in the provided changes; you never invent facts. Every item you emit must " +
  "carry sources[] citing the exact artifact ids it is derived from.";

/**
 * Generate the three release artifacts from a grounded change set and plan.
 *
 * Offline (MockProvider) the deterministic extractive baselines are returned
 * verbatim and verified (a clean no-op pass). With a real provider the same
 * baselines seed an abstractive rewrite that is verified and repaired in the
 * loop. `validSourceIds` is shared across all three calls — it is every artifact
 * id carried by the change set, the universe of legitimate citations.
 */
export async function write(
  changeSet: ChangeSet,
  plan: ReleasePlan,
  provider: LLMProvider,
): Promise<WriterOutput> {
  // The universe of legitimate citations: every artifact id any change is derived
  // from. The verifier flags any generated `sources[]` entry outside this set.
  const validSourceIds = new Set(collectSources(changeSet.changes));

  const changelogFallback = buildChangelogFallback(changeSet);
  const internalFallback = buildInternalNotesFallback(changeSet, plan);
  const customerFallback = buildCustomerNotesFallback(changeSet);

  // --- Changelog ------------------------------------------------------------
  const changelogResult = await groundedGenerate({
    provider,
    request: {
      agent: "writer:changelog",
      system: WRITER_SYSTEM,
      prompt:
        "Write a categorized changelog. One concise entry per change, grouped " +
        "by category. Cite each change's source ids.",
      schema: ChangelogDraftSchema,
      fallback: { changelog: changelogFallback },
    },
    extractItems: (value) => value.changelog,
    validSourceIds,
  });

  // --- Internal release notes -----------------------------------------------
  const internalResult = await groundedGenerate({
    provider,
    request: {
      agent: "writer:internal-notes",
      system: WRITER_SYSTEM,
      prompt:
        "Write INTERNAL release notes for maintainers. Include an overview, the " +
        "affected systems, an explicit risk level with its reasons, and the " +
        "notable changes with migration-relevant detail. Cite source ids per " +
        "section.",
      schema: NotesDraftSchema,
      fallback: { notes: internalFallback },
    },
    extractItems: (value) => value.notes,
    validSourceIds,
  });

  // --- Customer release notes -----------------------------------------------
  const customerResult = await groundedGenerate({
    provider,
    request: {
      agent: "writer:customer-notes",
      system:
        WRITER_SYSTEM +
        " For customer notes, write in plain, benefit-oriented language and NEVER " +
        "include internal identifiers (PR numbers, commit shas, ticket keys) in " +
        "the body — keep those only in sources[].",
      prompt:
        "Write CUSTOMER-facing release notes. Explain what's new as benefits and " +
        "what action (if any) is required, in plain language with no internal " +
        "identifiers in the prose. Still set sources[] for traceability.",
      schema: NotesDraftSchema,
      fallback: { notes: customerFallback },
    },
    extractItems: (value) => value.notes,
    validSourceIds,
  });

  return {
    changelog: changelogResult.value.changelog,
    internalReleaseNotes: internalResult.value.notes,
    customerReleaseNotes: customerResult.value.notes,
  };
}
