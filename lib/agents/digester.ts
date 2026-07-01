/**
 * Digester agent — the first "understanding" stage of the pipeline.
 *
 * Input: a `ReleaseInput` (the raw, linked source artifacts from the connector).
 * Output: a `ChangeSet` — normalized, deduplicated, *grounded* changes.
 *
 * DESIGN: hybrid extractive-baseline + LLM enrichment.
 *
 *   1. A deterministic pass walks the linked artifacts and builds one grounded
 *      `Change` per substantive unit (each reconstructed ticket + its PR(s) +
 *      commit(s), plus any notable standalone PR). Every Change cites only REAL
 *      artifact ids, so this baseline is faithful by construction. Pure
 *      translation/dependency-bump/internal noise is collapsed into at most one
 *      summarizing "chore" Change so the set stays signal-focused.
 *   2. That baseline is handed to `groundedGenerate` as the `fallback`. Offline
 *      (MockProvider, no key) the provider returns the fallback verbatim, so the
 *      deterministic path *is* the output — which is why it must be genuinely
 *      good. Online (Anthropic) the model rewrites summaries / reclassifies, and
 *      the in-loop verifier rejects any citation it invents.
 *
 * WHY ground on the *linked* artifacts rather than re-derive intent: the
 * connector already linked PRs↔tickets↔commits during harvest. Trusting that
 * linkage keeps the baseline deterministic and lets every Change point back to
 * concrete evidence a reviewer can open.
 */

import { findUnlinkedArtifactIds } from "@/lib/connectors";
import { groundedGenerate } from "@/lib/grounding";
import {
  ChangeSetSchema,
  type Change,
  type ChangeSet,
  type ChangeType,
  type Commit,
  type LLMProvider,
  type PullRequest,
  type ReleaseInput,
  type Ticket,
} from "@/lib/schemas";

/* ============================================================================
 * Type inference — map a PR's labels/title to a `ChangeType`.
 * ========================================================================== */

/**
 * PR labels in the FastAPI fixtures that map directly to a change type. Checked
 * before the title heuristics because a maintainer-applied label is a stronger
 * signal of intent than emoji/keywords in a title.
 *
 * `breaking` is handled separately (it sets `isBreaking` and forces the type),
 * so it is intentionally absent here.
 */
const LABEL_TO_TYPE: Record<string, ChangeType> = {
  feature: "feature",
  bug: "fix",
  fix: "fix",
  refactor: "refactor",
  perf: "perf",
  performance: "perf",
  docs: "docs",
  documentation: "docs",
  // Dependency/upgrade work: surfaced as `deps` so the Planner can weigh it.
  upgrade: "deps",
  dependencies: "deps",
  "python:uv": "deps",
  security: "security",
  // CI / tooling / internal housekeeping.
  internal: "chore",
  chore: "chore",
  "pre-commit": "chore",
  github_actions: "chore",
  test: "test",
  tests: "test",
};

/**
 * Title-keyword fallbacks when no label classifies the PR. FastAPI prefixes
 * commit/PR subjects with gitmoji (✨ feature, 🐛 fix, ♻️ refactor, ⬆️ upgrade,
 * 📝 docs, ⚡ perf, 🔒 security) plus the occasional plain English verb, so we
 * match both. Ordered list: first hit wins, so put the most specific first.
 */
const TITLE_PATTERNS: ReadonlyArray<readonly [RegExp, ChangeType]> = [
  [/^\s*✨|(\bfeat(ure)?\b)|(\badd\b)/i, "feature"],
  [/^\s*🐛|(\bfix(es|ed)?\b)|(\bbug\b)/i, "fix"],
  [/^\s*♻️|(\brefactor\b)/i, "refactor"],
  [/^\s*⚡️?|(\bperf\b)|(\bperformance\b)|(\bspeed up\b)/i, "perf"],
  [/^\s*🔒|(\bsecurity\b)|(\bvuln\b)/i, "security"],
  [/^\s*⬆️|(\bupgrade\b)|(\bbump\b)|(\bupdate\b .*\bdep)/i, "deps"],
  [/^\s*📝|(\bdocs?\b)|(\bdocumentation\b)/i, "docs"],
  [/^\s*🌐|(\btranslat)/i, "docs"],
  [/^\s*🔧|^\s*👷|(\bchore\b)|(\binternal\b)|(\bci\b)/i, "chore"],
];

/** A title/labels carry a "breaking" signal (case-insensitive, word-ish match). */
function looksBreaking(pr: PullRequest): boolean {
  if (pr.labels.some((l) => l.toLowerCase() === "breaking")) return true;
  // 💥 is the gitmoji for breaking; also match the literal word in the title.
  return /💥|\bbreaking\b/i.test(pr.title);
}

/** Infer the change type from a PR's labels first, then its title. */
function inferType(pr: PullRequest): ChangeType {
  if (looksBreaking(pr)) return "breaking";

  for (const label of pr.labels) {
    const mapped = LABEL_TO_TYPE[label.toLowerCase()];
    if (mapped) return mapped;
  }

  for (const [pattern, type] of TITLE_PATTERNS) {
    if (pattern.test(pr.title)) return type;
  }

  // Nothing matched: treat as housekeeping rather than guessing a louder type.
  return "chore";
}

/* ============================================================================
 * Component inference — derive affected areas from changed file paths.
 * ========================================================================== */

/** Path prefixes that describe *where* a change landed, not *what module* it touched. */
const NON_COMPONENT_TOPLEVEL = new Set([
  "tests",
  "test",
  "docs",
  "docs_src",
  "scripts",
  ".github",
]);

/**
 * Map a single changed file path to a component name, or null if the path is
 * test/docs/tooling scaffolding (which says nothing about the affected system).
 *
 * Heuristic, tuned to the Python source layout of the fixtures:
 *  - `fastapi/<mod>.py`      → `<mod>`            (e.g. `fastapi/sse.py` → `sse`)
 *  - `fastapi/<pkg>/...`     → `<pkg>`            (e.g. `fastapi/routing/...`)
 *  - other top-level files   → the top-level dir/file stem
 * A leading underscore (private package like `_compat`) is stripped so the
 * surfaced component reads as the public area (`compat`).
 */
function fileToComponent(path: string): string | null {
  const parts = path.split("/");
  const top = parts[0];
  if (NON_COMPONENT_TOPLEVEL.has(top)) return null;

  let component: string;
  if (top === "fastapi") {
    // `fastapi/x.py` → `x`; `fastapi/x/...` → `x`.
    component =
      parts.length === 2 ? parts[1].replace(/\.[^.]+$/, "") : parts[1];
  } else {
    // Non-fastapi top-level: use the dir name, or the file stem if it's a file.
    component = parts.length === 1 ? top.replace(/\.[^.]+$/, "") : top;
  }

  // Normalize private modules (`_compat` → `compat`) so the UI shows the area.
  component = component.replace(/^_+/, "");
  return component.length > 0 ? component : null;
}

/** Distinct components across a set of changed files, in first-seen order. */
function inferComponents(files: string[]): string[] {
  const seen = new Set<string>();
  for (const f of files) {
    const c = fileToComponent(f);
    if (c && !seen.has(c)) seen.add(c);
  }
  return [...seen];
}

/* ============================================================================
 * Summary / details extraction from a PR.
 * ========================================================================== */

/** Leading gitmoji + surrounding whitespace, stripped from a one-line summary. */
const LEADING_GITMOJI =
  /^\s*(?:[←-⇿⌀-➿⬀-⯿\u{1F000}-\u{1FAFF}️‍]+)\s*/u;

/** A clean one-line summary: the PR title without its leading gitmoji. */
function cleanSummary(title: string): string {
  return title.replace(LEADING_GITMOJI, "").trim() || title.trim();
}

/**
 * A short `details` paragraph extracted from the PR body.
 *
 * FastAPI PR bodies are mostly a boilerplate template (checklists, AI-disclaimer
 * `<details>`, the discussion stub). We keep only prose: strip HTML comments and
 * collapsed `<details>` blocks, drop checklist/heading/quote lines, then take the
 * first couple of substantive sentences. WHY truncate: `details` is a hint for
 * the writer and a tooltip in the UI, not the full PR — a few hundred chars is
 * plenty and keeps the ChangeSet small.
 */
function extractDetails(body: string): string {
  if (!body) return "";

  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, " ") // HTML comments (template hints)
    .replace(/<details>[\s\S]*?<\/details>/gi, " ") // collapsed AI transcripts
    .replace(/\r/g, "");

  const prose = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      if (line.startsWith("#")) return false; // markdown headings
      if (line.startsWith(">")) return false; // quotes / template notes
      if (/^[-*]\s*\[[ xX]\]/.test(line)) return false; // task-list checkboxes
      if (/^(discussion|checklist|description|ai disclaimer)\s*:?$/i.test(line))
        return false; // template section labels
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    // The body usually opens by repeating the gitmoji title; drop that prefix so
    // `details` doesn't lead with an emoji already shown in `summary`.
    .replace(LEADING_GITMOJI, "")
    .trim();

  if (prose.length === 0) return "";

  // Keep the first ~2 sentences, hard-capped, so details stay a hint not a dump.
  const MAX = 360;
  if (prose.length <= MAX) return prose;
  const clipped = prose.slice(0, MAX);
  const lastStop = clipped.lastIndexOf(". ");
  return (lastStop > 80 ? clipped.slice(0, lastStop + 1) : clipped).trim() + "…";
}

/* ============================================================================
 * Substantive-vs-noise classification.
 * ========================================================================== */

/** Labels that, on a *ticketless* PR, mark it as pure housekeeping. */
const NOISE_LABELS = new Set([
  "dependencies",
  "internal",
  "python:uv",
  "docs",
  "release",
  "pre-commit",
  "github_actions",
]);

/**
 * Does this PR touch genuine library source (not just a version bump)?
 *
 * "Substantive source" = a changed file under `fastapi/` that is NOT the
 * package's `__init__.py`. WHY exclude `__init__.py`: in this window the only
 * ticketless PRs that touch `fastapi/` are the three `🔖 Release version 0.137.x`
 * tags, whose sole source edit is bumping `__version__` in `fastapi/__init__.py`.
 * That is release plumbing, not a code change, so it must not be promoted to a
 * substantive Change.
 */
function touchesSubstantiveSource(pr: PullRequest): boolean {
  return pr.files.some(
    (f) => f.startsWith("fastapi/") && !f.endsWith("__init__.py"),
  );
}

/**
 * Is this PR worth its own Change, or should it collapse into the noise bucket?
 *
 * A PR is substantive when EITHER:
 *  - it has a linked ticket (the harvest links exactly the substantive PRs —
 *    feature/fix/breaking/refactor/upgrade — to reconstructed tickets; see
 *    data/README.md), OR
 *  - as an escape hatch for a *notable standalone* PR, it touches real library
 *    source AND isn't labelled as plain housekeeping (deps/internal/release/…).
 *
 * Everything else — translations, dependency bumps, CI, sponsor edits, release
 * tags — is noise and gets summarized into a single chore Change. WHY linkage,
 * not the title verb: ticketless PRs here are titled "Add …" / "Fix …" / "Bump …"
 * for docs/CI work, so a title-keyword rule wrongly promotes 18 housekeeping PRs.
 */
function isSubstantive(pr: PullRequest, hasTicket: boolean): boolean {
  if (hasTicket) return true;
  if (pr.labels.some((l) => NOISE_LABELS.has(l.toLowerCase()))) return false;
  return touchesSubstantiveSource(pr);
}

/* ============================================================================
 * Deterministic baseline construction.
 * ========================================================================== */

/**
 * Build the deterministic, grounded `ChangeSet` from the linked artifacts.
 *
 * Strategy:
 *  - Index commits by the PR number they reference, so each PR can gather its
 *    commit ids as additional provenance.
 *  - One Change per *substantive* PR (ticket-linked, or a notable standalone
 *    source change). Its `sourceIds` = the ticket id(s) + the PR id + its commit
 *    id(s) — all real, so the baseline is faithful by construction.
 *  - All remaining PRs (ticketless translations/deps/CI/release noise) collapse
 *    into a single summarizing "chore" Change citing a bounded sample of their
 *    ids, so the set foregrounds signal while still acknowledging the noise.
 */
export function buildDeterministicChangeSet(input: ReleaseInput): ChangeSet {
  // PR number → its commit ids (a PR's commits are extra provenance for it).
  const commitsByPr = new Map<number, Commit[]>();
  for (const commit of input.commits) {
    for (const prNumber of commit.prNumbers) {
      const list = commitsByPr.get(prNumber) ?? [];
      list.push(commit);
      commitsByPr.set(prNumber, list);
    }
  }

  // ticket key → ticket, for fast PR→ticket resolution.
  const ticketByKey = new Map<string, Ticket>(
    input.tickets.map((t) => [t.key, t]),
  );

  const substantive: Change[] = [];
  const noisePrIds: string[] = [];

  for (const pr of input.pullRequests) {
    const type = inferType(pr);
    const linkedTickets = pr.ticketKeys
      .map((k) => ticketByKey.get(k))
      .filter((t): t is Ticket => t !== undefined);
    const hasTicket = linkedTickets.length > 0;
    const prCommits = commitsByPr.get(pr.number) ?? [];

    // Collapse ticketless housekeeping (translations/deps/CI/release) into the
    // noise bucket; keep only ticket-linked or notable-source PRs as Changes.
    if (!isSubstantive(pr, hasTicket)) {
      noisePrIds.push(pr.id);
      continue;
    }

    // sourceIds: ticket(s) → PR → commit(s). Order is intentional (most
    // intent-bearing first) and every id is real, satisfying the min(1) +
    // grounding guarantee.
    const sourceIds = [
      ...linkedTickets.map((t) => t.id),
      pr.id,
      ...prCommits.map((c) => c.id),
    ];

    substantive.push({
      id: `chg-pr-${pr.number}`,
      type,
      summary: cleanSummary(pr.title),
      details: extractDetails(pr.body),
      components: inferComponents(pr.files),
      sourceIds,
      isBreaking: looksBreaking(pr),
    });
  }

  const changes = [...substantive];

  // Collapse the noise into one honest summarizing Change (omit if there is
  // none). We cite a bounded sample of real ids so the Change is grounded
  // without ballooning sourceIds to hundreds of entries.
  if (noisePrIds.length > 0) {
    const SAMPLE = 12;
    changes.push({
      id: "chg-internal-noise",
      type: "chore",
      summary: `Routine maintenance: ${noisePrIds.length} translation, dependency, and internal PRs`,
      details:
        "Aggregated translation, dependency-bump, CI, and internal-tooling " +
        "pull requests with no linked tracking ticket. Collapsed into one " +
        "entry so the change set foregrounds substantive work; the full list " +
        "is preserved in unlinkedArtifactIds.",
      components: [],
      // Sample of real ids keeps this grounded; full set lives in unlinked below.
      sourceIds: noisePrIds.slice(0, SAMPLE),
      isBreaking: false,
    });
  }

  return ChangeSetSchema.parse({
    changes,
    // The incomplete-information signal: every PR/commit we couldn't tie to a
    // ticket. Large (>100) for this window because most FastAPI PRs are
    // intentionally ticketless (see data/README.md).
    unlinkedArtifactIds: findUnlinkedArtifactIds(input),
  });
}

/* ============================================================================
 * Prompt construction for the LLM enrichment pass.
 * ========================================================================== */

const DIGESTER_SYSTEM = [
  "You are a release engineer normalizing a software release into a clean set of changes.",
  "You are given a deterministic, already-grounded draft change set extracted from real",
  "commits, pull requests, and tickets. Improve it: write crisp one-line summaries, fix",
  "obvious mis-classifications of `type`, and tighten `details`.",
  "",
  "HARD RULES:",
  "- Cite ONLY artifact ids that appear in the provided draft. Never invent an id.",
  "- Keep every change's `sourceIds` non-empty (>=1 real id).",
  "- Do not drop a substantive change; you may refine it.",
  "- Preserve `isBreaking` for anything already flagged breaking.",
  "- Return the full ChangeSet JSON matching the provided schema.",
].join("\n");

/** Build the enrichment prompt: hand the model the normalized draft as JSON. */
function buildDigesterPrompt(draft: ChangeSet): string {
  return [
    "Here is the deterministic draft change set (already grounded in real ids):",
    "",
    JSON.stringify(draft, null, 2),
    "",
    "Return an improved ChangeSet with the same structure. Keep `unlinkedArtifactIds`",
    "as-is. Improve summaries/details/types of `changes`, citing only ids present above.",
  ].join("\n");
}

/* ============================================================================
 * Public entry point.
 * ========================================================================== */

/**
 * Digest a release into a grounded `ChangeSet`.
 *
 * Builds the deterministic baseline, then runs it through `groundedGenerate` so
 * that (offline) the faithful baseline is returned verbatim, and (online) an LLM
 * enrichment is accepted only if it cites real ids — any fabricated citation is
 * caught by the in-loop verifier and repaired/surfaced.
 *
 * @param input    The linked source artifacts for the release window.
 * @param provider The AI boundary (MockProvider offline, AnthropicProvider live).
 */
export async function digest(
  input: ReleaseInput,
  provider: LLMProvider,
): Promise<ChangeSet> {
  const deterministic = buildDeterministicChangeSet(input);

  // Every real artifact id in the window — the verifier's allow-list. A model
  // may only cite from this set; anything else is flagged as fabricated.
  const validSourceIds = new Set<string>([
    ...input.commits.map((c) => c.id),
    ...input.pullRequests.map((p) => p.id),
    ...input.tickets.map((t) => t.id),
  ]);

  const { value } = await groundedGenerate<ChangeSet>({
    provider,
    request: {
      agent: "digester",
      system: DIGESTER_SYSTEM,
      prompt: buildDigesterPrompt(deterministic),
      schema: ChangeSetSchema,
      fallback: deterministic,
    },
    // Project each change down to the citation-bearing shape the verifier checks.
    extractItems: (cs) => cs.changes.map((c) => ({ sources: c.sourceIds })),
    validSourceIds,
  });

  return value;
}
