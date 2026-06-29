/**
 * Evaluation metrics for a generated `ReleasePackage`.
 *
 * These are the *graded* metrics from the assessment, so they are written to be
 * **honest**, not flattering. Two design commitments run through the whole file:
 *
 *  1. **Grounding is checkable, so we check it.** Every generated artifact item
 *     carries `sources` (ids of the commits / PRs / tickets it derives from — see
 *     the schema contract). Hallucination is therefore not a vibe: it is the
 *     fraction of items whose citations don't resolve to a real source id.
 *
 *  2. **The "did it change?" proxy is noisy; the curated gold is primary.** A doc
 *     can be stale (documentation debt): the project may *not* have touched a file
 *     that genuinely needed updating, and vice-versa. So `changedDocPaths` is only
 *     ever used as a SECONDARY, explicitly-labelled "weak proxy / recall lower
 *     bound", while precision/recall/F1 are measured against the hand-curated
 *     `curated-gold.json`. Recommending a doc the project didn't touch is reported
 *     as *possible doc debt*, never silently counted as a false positive.
 *
 * Everything here is a pure function over already-loaded values (no I/O), so each
 * metric is trivially unit-testable with synthetic `ReleasePackage` fixtures.
 */

import type {
  ReleasePackage,
  ReleaseInput,
  GroundTruth,
  CuratedGold,
} from "@/lib/schemas";

/* ============================================================================
 * Shared id helpers
 *
 * Source ids are namespaced strings (`commit:<sha>`, `pr:<number>`,
 * `ticket:<KEY>`). The eval only ever joins on these, so the parsing lives in
 * one place and every metric agrees on what a "PR citation" or "ticket citation"
 * means.
 * ========================================================================== */

/** Parse `pr:<n>` → the numeric PR id, or `null` if `id` isn't a PR citation. */
export function parsePrNumber(id: string): number | null {
  const m = /^pr:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Parse `ticket:<KEY>` → the bare ticket key, or `null` if not a ticket id. */
export function parseTicketKey(id: string): string | null {
  const m = /^ticket:(.+)$/.exec(id);
  return m ? m[1] : null;
}

/**
 * Every `sources[]` array across the generated artifacts, flattened.
 *
 * The four artifact families each ground their claims with `sources`, so the
 * hallucination and coverage checks treat them uniformly: a citation is a
 * citation regardless of which family produced it.
 */
function allArtifactSources(pkg: ReleasePackage): string[] {
  const { changelog, internalReleaseNotes, customerReleaseNotes, documentationUpdates } =
    pkg.artifacts;
  return [
    ...changelog.flatMap((e) => e.sources),
    ...internalReleaseNotes.flatMap((s) => s.sources),
    ...customerReleaseNotes.flatMap((s) => s.sources),
    ...documentationUpdates.flatMap((d) => d.sources),
  ];
}

/* ============================================================================
 * (a) Hallucination rate
 * ========================================================================== */

/** One artifact item flagged as ungrounded, with enough context to locate it. */
export interface FlaggedItem {
  /** Which artifact family the item came from. */
  kind: "changelog" | "internalNote" | "customerNote" | "docUpdate";
  /** A short human label for the item (its text/heading/docPath). */
  label: string;
  /** The offending source ids on this item: unknown ids, or `[]` if it cited nothing. */
  badSources: string[];
}

export interface HallucinationResult {
  /** Total artifact items considered (each changelog entry / note / doc update). */
  totalItems: number;
  /** Items with at least one unknown source id, or no sources at all. */
  hallucinatedItems: number;
  /** `hallucinatedItems / totalItems` (0 when there are no items). */
  rate: number;
  flagged: FlaggedItem[];
}

/**
 * Fraction of artifact items whose `sources` reference unknown/empty ids.
 *
 * An item is "hallucinated" if it cites **no** source, OR if **any** cited id is
 * absent from `validIds`. We flag at the item level (not per-citation) because
 * the unit a reviewer acts on is the claim — a changelog line, a note section, a
 * doc suggestion — and a single bad citation is enough to make that claim
 * untrustworthy. Empty `sources` counts as a hallucination because the grounding
 * guarantee is "every claim is traceable to evidence": an unsourced claim is
 * exactly the failure this metric exists to catch.
 *
 * @param validIds the set of legitimate source ids for this release (typically
 *   the ids of every commit / PR / ticket in the `ReleaseInput`).
 */
export function hallucinationRate(
  pkg: ReleasePackage,
  validIds: Set<string>,
): HallucinationResult {
  const flagged: FlaggedItem[] = [];

  /** Push a flag if this item is ungrounded; returns whether it was flagged. */
  const consider = (
    kind: FlaggedItem["kind"],
    label: string,
    sources: string[],
  ): boolean => {
    // Unknown OR empty: an empty citation list is an ungrounded claim.
    const bad = sources.filter((id) => !validIds.has(id));
    const isHallucinated = sources.length === 0 || bad.length > 0;
    if (isHallucinated) {
      flagged.push({ kind, label, badSources: sources.length === 0 ? [] : bad });
    }
    return isHallucinated;
  };

  const { changelog, internalReleaseNotes, customerReleaseNotes, documentationUpdates } =
    pkg.artifacts;

  let totalItems = 0;
  let hallucinatedItems = 0;
  const tally = (flaggedNow: boolean) => {
    totalItems += 1;
    if (flaggedNow) hallucinatedItems += 1;
  };

  for (const e of changelog) tally(consider("changelog", e.text, e.sources));
  for (const s of internalReleaseNotes)
    tally(consider("internalNote", s.heading, s.sources));
  for (const s of customerReleaseNotes)
    tally(consider("customerNote", s.heading, s.sources));
  for (const d of documentationUpdates)
    tally(consider("docUpdate", d.docPath, d.sources));

  // Define the rate as 0 (not NaN) for an empty package: "nothing generated" is
  // not "everything hallucinated". Callers that care can read `totalItems`.
  const rate = totalItems === 0 ? 0 : hallucinatedItems / totalItems;
  return { totalItems, hallucinatedItems, rate, flagged };
}

/* ============================================================================
 * (b) Ticket coverage
 * ========================================================================== */

export interface TicketCoverageResult {
  /** Total tickets in the release input. */
  total: number;
  /** How many of those tickets are cited somewhere in the artifacts. */
  covered: number;
  /** Keys of tickets that appear in no artifact citation. */
  missingTicketKeys: string[];
}

/**
 * How many of the release's tickets are actually cited in the generated output.
 *
 * "Covered" = the ticket's id (`ticket:<KEY>`) appears in some artifact's
 * `sources`. We deliberately measure coverage from the *artifacts*, not from the
 * intermediate change set: the question this metric answers is "did the output a
 * human will read account for every known unit of intent?", and only the
 * artifacts are read.
 *
 * Note on the FastAPI window: only the 7 substantive PRs carry tickets (the
 * translation/internal PRs are intentionally ticketless — see data/README), so a
 * high coverage here means the substantive work was all surfaced. The flip side
 * (the ~150 ticketless PRs) is the *incomplete-information* signal, tracked
 * separately by the connector's `findUnlinkedArtifactIds`, not penalized here.
 */
export function ticketCoverage(
  pkg: ReleasePackage,
  input: ReleaseInput,
): TicketCoverageResult {
  // The set of ticket keys cited anywhere in the artifacts.
  const citedTicketKeys = new Set<string>();
  for (const id of allArtifactSources(pkg)) {
    const key = parseTicketKey(id);
    if (key !== null) citedTicketKeys.add(key);
  }

  const allKeys = input.tickets.map((t) => t.key);
  const missingTicketKeys = allKeys.filter((k) => !citedTicketKeys.has(k));

  return {
    total: allKeys.length,
    covered: allKeys.length - missingTicketKeys.length,
    missingTicketKeys,
  };
}

/* ============================================================================
 * (c) Documentation-recommendation accuracy
 * ========================================================================== */

export interface DocRecommendationResult {
  /** Distinct docPaths the system recommended updating. */
  recommended: string[];
  /** ---- PRIMARY: precision / recall / F1 vs the hand-curated gold set. ---- */
  primary: {
    /** Recommended docs that are in the curated gold set. */
    truePositives: string[];
    /** Recommended docs NOT in the curated gold (w.r.t. the curated set only). */
    falsePositives: string[];
    /** Curated-gold docs the system failed to recommend. */
    falseNegatives: string[];
    precision: number;
    recall: number;
    f1: number;
  };
  /**
   * ---- SECONDARY: recall vs the changed-docs proxy. ----
   * This is a **weak proxy / recall lower bound**, NOT precision-able: the
   * project may carry doc debt, so a recommended doc that is absent from
   * `changedDocPaths` may well be a *correct* find (real debt) rather than a
   * false positive. We therefore report recall against the proxy only, and label
   * it as a lower bound.
   */
  proxy: {
    /** Recommended docs that did in fact change between the tags. */
    matchedChangedDocs: string[];
    /** How many of the changed docs the system recommended (recall, lower bound). */
    recallLowerBound: number;
  };
  /**
   * Recommended docs that are NOT in `changedDocPaths`. Per the DESIGN note, a
   * divergence from the proxy may be a correct documentation-debt find, not an
   * error — so this is surfaced as a count to investigate, never as a penalty.
   */
  possibleDocDebtCount: number;
  /** The doc paths behind `possibleDocDebtCount`, for inspection. */
  possibleDocDebtPaths: string[];
}

/**
 * Precision/recall/F1 of the system's documentation recommendations.
 *
 * PRIMARY signal — the hand-curated `curated-gold.json`. These are real inputs
 * with human-judged labels (single annotator; limitation documented in DESIGN),
 * and they are the only set against which it is fair to compute *precision*:
 * "of the docs we recommended, how many should truly change?".
 *
 * SECONDARY signal — `gt.changedDocPaths`, the docs that actually changed
 * between the tags. Reported ONLY as a recall lower bound, because it is a noisy
 * proxy: a project carrying documentation debt will have genuinely-impacted docs
 * that nobody updated, so the proxy under-counts truth. Crucially, a recommended
 * doc that is *not* in `changedDocPaths` is reported as `possibleDocDebt`, not as
 * a false positive — diverging from the proxy may mean the system correctly
 * spotted debt the maintainers missed.
 *
 * Match key: `docPath` (the bare flattened filename the connector exposes), so
 * recommendations join directly against both gold sets.
 */
export function docRecommendationAccuracy(
  pkg: ReleasePackage,
  curated: CuratedGold,
  gt: GroundTruth,
): DocRecommendationResult {
  // Distinct recommended docs (a writer may emit several suggestions per file).
  const recommended = [
    ...new Set(pkg.artifacts.documentationUpdates.map((d) => d.docPath)),
  ];
  const recommendedSet = new Set(recommended);

  // ---- PRIMARY: vs curated gold ----
  const goldSet = new Set(curated.impactedDocs.map((d) => d.docPath));
  const truePositives = recommended.filter((p) => goldSet.has(p));
  const falsePositives = recommended.filter((p) => !goldSet.has(p));
  const falseNegatives = [...goldSet].filter((p) => !recommendedSet.has(p));

  // ratio(a, b) = a / b, defined as 0 when the denominator is 0 so an empty
  // recommendation set (precision) or empty gold set (recall) yields 0, not NaN.
  const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);
  const precision = ratio(truePositives.length, recommended.length);
  const recall = ratio(truePositives.length, goldSet.size);
  // Harmonic mean; 0 when either component is 0 (also avoids 0/0).
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // ---- SECONDARY: vs the changed-docs proxy (recall lower bound only) ----
  const changedSet = new Set(gt.changedDocPaths);
  const matchedChangedDocs = recommended.filter((p) => changedSet.has(p));
  const recallLowerBound = ratio(matchedChangedDocs.length, changedSet.size);

  // Recommended-but-not-changed: candidate documentation debt, NOT an error.
  const possibleDocDebtPaths = recommended.filter((p) => !changedSet.has(p));

  return {
    recommended,
    primary: {
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1,
    },
    proxy: { matchedChangedDocs, recallLowerBound },
    possibleDocDebtCount: possibleDocDebtPaths.length,
    possibleDocDebtPaths,
  };
}

/* ============================================================================
 * (d) Changelog recall
 * ========================================================================== */

/**
 * The substantive release-note categories — the ones a changelog *should* carry.
 *
 * Translations / Internal / Docs are deliberately excluded: in the FastAPI window
 * 36 PRs are translations and many more are internal/CI chores, and correctly
 * *omitting* those from a user-facing changelog is good behavior, not a miss. So
 * the headline recall is computed over substantive categories only; reporting the
 * raw all-categories recall too would unfairly punish the right call.
 */
export const SUBSTANTIVE_CATEGORIES: ReadonlySet<string> = new Set([
  "Breaking Changes",
  "Features",
  "Fixes",
  "Refactors",
  "Upgrades",
  "Perf",
  "Security",
]);

/** Precision/recall (+ the matched/missed PR numbers) for one slice. */
export interface RecallSlice {
  /** Reference PR numbers in this slice (the denominator for recall). */
  relevant: number[];
  /** Reference PRs the changelog cited (correctly). */
  matched: number[];
  /** Reference PRs the changelog missed. */
  missed: number[];
  recall: number;
}

export interface ChangelogRecallResult {
  /** Distinct PR numbers cited across all changelog entries (`pr:<n>` sources). */
  citedPrNumbers: number[];
  /** Recall + precision over ALL release-note PRs (every category). */
  overall: {
    relevant: number[];
    matched: number[];
    missed: number[];
    recall: number;
    /**
     * Of the changelog's PR citations that are in the release notes at all, the
     * fraction that are real release-note PRs. Computed against the union of
     * release-note PRs (any category), so citing a translation PR that *was* in
     * the notes is not a precision hit — only citing a PR absent from the notes
     * entirely is. Reported for completeness alongside the recall headline.
     */
    precision: number;
  };
  /**
   * Recall over SUBSTANTIVE categories only (the headline number). Excludes
   * Translations / Internal / Docs so correctly omitting 36 translation PRs is
   * not penalized — see `SUBSTANTIVE_CATEGORIES`.
   */
  substantive: RecallSlice;
  /** Per-category recall, for the categories present in the ground truth. */
  byCategory: Record<string, RecallSlice>;
}

/**
 * Recall (and precision) of the changelog vs the published release-note PRs,
 * matched by PR number parsed from each entry's `sources` (`pr:<n>`).
 *
 * Why recall is the headline: the job of a changelog is *completeness* — did we
 * surface the changes that shipped? We additionally report precision over the
 * release-note union so that fabricated/irrelevant entries (PRs that were never
 * in the notes) are visible too.
 *
 * Computed three ways, deliberately:
 *  - `byCategory`  — recall within each release-note category, so a weakness
 *                    (e.g. missing a Breaking Change) isn't hidden by volume.
 *  - `substantive` — recall over the substantive categories only (the headline),
 *                    which is the honest target: omitting translations is correct.
 *  - `overall`     — recall over every release-note PR, for context. This will be
 *                    low *by design* (most PRs are translations/internal that a
 *                    good changelog omits), and that's the point of also having
 *                    the substantive slice.
 */
export function changelogRecall(
  pkg: ReleasePackage,
  gt: GroundTruth,
): ChangelogRecallResult {
  // PR numbers cited across all changelog entries.
  const citedPrSet = new Set<number>();
  for (const entry of pkg.artifacts.changelog) {
    for (const id of entry.sources) {
      const n = parsePrNumber(id);
      if (n !== null) citedPrSet.add(n);
    }
  }
  const citedPrNumbers = [...citedPrSet].sort((a, b) => a - b);

  const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

  /** Build a recall slice: which of `relevant` were cited, which missed. */
  const slice = (relevant: number[]): RecallSlice => {
    const matched = relevant.filter((n) => citedPrSet.has(n));
    const missed = relevant.filter((n) => !citedPrSet.has(n));
    return { relevant, matched, missed, recall: ratio(matched.length, relevant.length) };
  };

  // ---- overall (every release-note PR) ----
  const allRelevant = gt.releaseNotePrNumbers;
  const allRelevantSet = new Set(allRelevant);
  const overallSlice = slice(allRelevant);
  // Precision: cited PRs that are real release-note PRs / all cited PRs.
  const precisionMatches = citedPrNumbers.filter((n) => allRelevantSet.has(n));
  const precision = ratio(precisionMatches.length, citedPrNumbers.length);

  // ---- by category ----
  // Invert releaseNotePrCategories (PR → category) into category → PR numbers.
  const prsByCategory = new Map<string, number[]>();
  for (const [prStr, category] of Object.entries(gt.releaseNotePrCategories)) {
    const n = Number(prStr);
    const list = prsByCategory.get(category) ?? [];
    list.push(n);
    prsByCategory.set(category, list);
  }
  const byCategory: Record<string, RecallSlice> = {};
  for (const [category, prs] of prsByCategory) {
    byCategory[category] = slice(prs.sort((a, b) => a - b));
  }

  // ---- substantive only (the headline) ----
  // Union the PRs across substantive categories from the category map. (We use
  // the category map, not releaseNotePrNumbers, because category is what defines
  // "substantive".)
  const substantivePrs: number[] = [];
  for (const [category, prs] of prsByCategory) {
    if (SUBSTANTIVE_CATEGORIES.has(category)) substantivePrs.push(...prs);
  }
  const substantive = slice([...new Set(substantivePrs)].sort((a, b) => a - b));

  return {
    citedPrNumbers,
    overall: {
      relevant: overallSlice.relevant,
      matched: overallSlice.matched,
      missed: overallSlice.missed,
      recall: overallSlice.recall,
      precision,
    },
    substantive,
    byCategory,
  };
}

/* ============================================================================
 * (e) Aggregate report
 * ========================================================================== */

/** The single object that aggregates every metric for one pipeline run. */
export interface EvalReport {
  release: ReleasePackage["release"];
  hallucination: HallucinationResult;
  ticketCoverage: TicketCoverageResult;
  docRecommendation: DocRecommendationResult;
  changelogRecall: ChangelogRecallResult;
}

/**
 * Run every metric over one `ReleasePackage` and return a single `EvalReport`.
 *
 * `validIds` for the hallucination check is derived here as the ids of every
 * source artifact in the `ReleaseInput` (commits + PRs + tickets): those are
 * exactly the ids a grounded artifact is allowed to cite. Deriving it in one
 * place keeps the definition of "a valid citation" consistent with the rest of
 * the pipeline and out of each caller's hands.
 */
export function runEval(
  pkg: ReleasePackage,
  input: ReleaseInput,
  gt: GroundTruth,
  curated: CuratedGold,
): EvalReport {
  const validIds = new Set<string>([
    ...input.commits.map((c) => c.id),
    ...input.pullRequests.map((p) => p.id),
    ...input.tickets.map((t) => t.id),
  ]);

  return {
    release: pkg.release,
    hallucination: hallucinationRate(pkg, validIds),
    ticketCoverage: ticketCoverage(pkg, input),
    docRecommendation: docRecommendationAccuracy(pkg, curated, gt),
    changelogRecall: changelogRecall(pkg, gt),
  };
}
