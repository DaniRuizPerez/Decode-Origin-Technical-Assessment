import { describe, it, expect } from "vitest";

import {
  ReleasePackageSchema,
  ReleaseInputSchema,
  GroundTruthSchema,
  CuratedGoldSchema,
  type ReleasePackage,
  type ReleaseInput,
  type GroundTruth,
  type CuratedGold,
  type ReleaseArtifacts,
} from "@/lib/schemas";

import {
  hallucinationRate,
  ticketCoverage,
  docRecommendationAccuracy,
  changelogRecall,
  runEval,
  parsePrNumber,
  parseTicketKey,
} from "./metrics";

/* ============================================================================
 * Synthetic fixture builders
 *
 * Every metric is a pure function over schema types, so we test against tiny
 * HAND-BUILT packages (constructed through the real schemas, so they're provably
 * valid) rather than the big harvested fixtures. That keeps each assertion exact
 * and lets us plant specific faults (the fault-injection test) deterministically.
 * ========================================================================== */

const RELEASE = {
  project: "test/proj",
  baseRef: "v1",
  headRef: "v2",
  name: "v2",
};

/** Build a valid `ReleasePackage` whose artifacts are the only thing that varies. */
function makePackage(artifacts: ReleaseArtifacts): ReleasePackage {
  return ReleasePackageSchema.parse({
    release: RELEASE,
    changeSet: { changes: [], unlinkedArtifactIds: [] },
    plan: {
      themes: [],
      affectedSystems: [],
      risk: { level: "low", reasons: [] },
      coverage: { total: 0, covered: 0, missingTicketKeys: [] },
    },
    artifacts,
    // retrieval / trace / approval fall back to their schema defaults.
  });
}

/** Empty-but-valid artifacts; spread-override the family a test cares about. */
const EMPTY_ARTIFACTS: ReleaseArtifacts = {
  changelog: [],
  internalReleaseNotes: [],
  customerReleaseNotes: [],
  documentationUpdates: [],
};

/** A minimal valid `ReleaseInput` with the given tickets and a couple of PRs. */
function makeInput(opts: {
  prNumbers?: number[];
  ticketKeys?: string[];
}): ReleaseInput {
  return ReleaseInputSchema.parse({
    release: RELEASE,
    commits: [],
    pullRequests: (opts.prNumbers ?? []).map((n) => ({
      id: `pr:${n}`,
      number: n,
      title: `PR ${n}`,
      author: "octocat",
    })),
    tickets: (opts.ticketKeys ?? []).map((key) => ({
      id: `ticket:${key}`,
      key,
      summary: `Ticket ${key}`,
    })),
  });
}

function makeGroundTruth(opts: {
  releaseNotePrNumbers?: number[];
  releaseNotePrCategories?: Record<string, string>;
  changedDocPaths?: string[];
}): GroundTruth {
  return GroundTruthSchema.parse({
    release: RELEASE,
    releaseNotePrNumbers: opts.releaseNotePrNumbers ?? [],
    releaseNotePrCategories: opts.releaseNotePrCategories ?? {},
    changedDocPaths: opts.changedDocPaths ?? [],
  });
}

function makeCurated(docPaths: string[]): CuratedGold {
  return CuratedGoldSchema.parse({
    release: RELEASE,
    impactedDocs: docPaths.map((docPath) => ({ docPath, rationale: "because" })),
  });
}

/* ============================================================================
 * id helpers
 * ========================================================================== */

describe("id parsing helpers", () => {
  it("parses pr:<n> and rejects non-PR ids", () => {
    expect(parsePrNumber("pr:15745")).toBe(15745);
    expect(parsePrNumber("commit:abc")).toBeNull();
    expect(parsePrNumber("pr:notanumber")).toBeNull();
    expect(parsePrNumber("ticket:FAPI-1")).toBeNull();
  });

  it("parses ticket:<KEY> and rejects non-ticket ids", () => {
    expect(parseTicketKey("ticket:FAPI-1003")).toBe("FAPI-1003");
    expect(parseTicketKey("pr:42")).toBeNull();
    expect(parseTicketKey("commit:abc")).toBeNull();
  });
});

/* ============================================================================
 * (a) hallucinationRate — including the fault-injection test
 * ========================================================================== */

describe("hallucinationRate", () => {
  const validIds = new Set(["pr:1", "pr:2", "ticket:T-1", "commit:abc"]);

  it("reports a zero rate when every item is fully grounded", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [
        { category: "Features", text: "Add X", sources: ["pr:1"] },
        { category: "Fixes", text: "Fix Y", sources: ["pr:2", "ticket:T-1"] },
      ],
      internalReleaseNotes: [{ heading: "Overview", body: "...", sources: ["commit:abc"] }],
    });

    const result = hallucinationRate(pkg, validIds);
    expect(result.totalItems).toBe(3);
    expect(result.hallucinatedItems).toBe(0);
    expect(result.rate).toBe(0);
    expect(result.flagged).toEqual([]);
  });

  it("flags items with empty sources as ungrounded", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      // A note with NO sources is an unsupported claim — must be flagged.
      customerReleaseNotes: [{ heading: "What's new", body: "...", sources: [] }],
    });

    const result = hallucinationRate(pkg, validIds);
    expect(result.totalItems).toBe(1);
    expect(result.hallucinatedItems).toBe(1);
    expect(result.rate).toBe(1);
    expect(result.flagged[0]).toMatchObject({ kind: "customerNote", badSources: [] });
  });

  it("treats an empty package as rate 0 (nothing generated != all hallucinated)", () => {
    const result = hallucinationRate(makePackage(EMPTY_ARTIFACTS), validIds);
    expect(result.totalItems).toBe(0);
    expect(result.rate).toBe(0);
  });

  it("FAULT INJECTION: a planted bad-source item raises the rate", () => {
    // Baseline: three clean items, rate 0.
    const cleanArtifacts: ReleaseArtifacts = {
      ...EMPTY_ARTIFACTS,
      changelog: [
        { category: "Features", text: "Add X", sources: ["pr:1"] },
        { category: "Fixes", text: "Fix Y", sources: ["pr:2"] },
      ],
      documentationUpdates: [
        {
          docPath: "guide.md",
          section: "Intro",
          suggestion: "update",
          retrievedChunkId: null,
          sources: ["ticket:T-1"],
          isPossibleDocDebt: false,
        },
      ],
    };
    const clean = hallucinationRate(makePackage(cleanArtifacts), validIds);
    expect(clean.rate).toBe(0);

    // Inject one entry citing a PR that does not exist in the source set.
    const poisoned = hallucinationRate(
      makePackage({
        ...cleanArtifacts,
        changelog: [
          ...cleanArtifacts.changelog,
          { category: "Features", text: "Fabricated feature", sources: ["pr:9999"] },
        ],
      }),
      validIds,
    );

    // The planted item must be caught and must push the rate up.
    expect(poisoned.totalItems).toBe(clean.totalItems + 1);
    expect(poisoned.hallucinatedItems).toBe(1);
    expect(poisoned.rate).toBeGreaterThan(clean.rate);
    expect(poisoned.rate).toBeCloseTo(1 / 4);
    expect(poisoned.flagged).toEqual([
      { kind: "changelog", label: "Fabricated feature", badSources: ["pr:9999"] },
    ]);
  });

  it("flags an item if ANY of several sources is unknown", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [{ category: "Features", text: "Mixed", sources: ["pr:1", "pr:9999"] }],
    });
    const result = hallucinationRate(pkg, validIds);
    expect(result.hallucinatedItems).toBe(1);
    // Only the unknown id is reported as bad, not the valid one.
    expect(result.flagged[0].badSources).toEqual(["pr:9999"]);
  });
});

/* ============================================================================
 * (b) ticketCoverage
 * ========================================================================== */

describe("ticketCoverage", () => {
  const input = makeInput({ ticketKeys: ["T-1", "T-2", "T-3"] });

  it("counts tickets cited anywhere across the artifacts", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [{ category: "Features", text: "X", sources: ["ticket:T-1", "pr:1"] }],
      // A ticket cited from a note still counts — coverage is artifact-wide.
      internalReleaseNotes: [{ heading: "H", body: "b", sources: ["ticket:T-2"] }],
    });

    const result = ticketCoverage(pkg, input);
    expect(result.total).toBe(3);
    expect(result.covered).toBe(2);
    expect(result.missingTicketKeys).toEqual(["T-3"]);
  });

  it("reports full coverage when every ticket is cited", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [
        { category: "x", text: "x", sources: ["ticket:T-1", "ticket:T-2", "ticket:T-3"] },
      ],
    });
    const result = ticketCoverage(pkg, input);
    expect(result.covered).toBe(3);
    expect(result.missingTicketKeys).toEqual([]);
  });

  it("reports zero coverage (all missing) when no tickets are cited", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [{ category: "x", text: "x", sources: ["pr:1"] }],
    });
    const result = ticketCoverage(pkg, input);
    expect(result.covered).toBe(0);
    expect(result.missingTicketKeys).toEqual(["T-1", "T-2", "T-3"]);
  });
});

/* ============================================================================
 * (c) docRecommendationAccuracy
 * ========================================================================== */

describe("docRecommendationAccuracy", () => {
  // Curated gold = the two docs that truly need updating.
  const curated = makeCurated(["a.md", "b.md"]);
  // Changed-docs proxy: a.md changed, b.md did NOT (doc debt), z.md changed.
  const gt = makeGroundTruth({ changedDocPaths: ["a.md", "z.md"] });

  /** Helper to make a package recommending the given doc paths. */
  function recommend(docPaths: string[]): ReleasePackage {
    return makePackage({
      ...EMPTY_ARTIFACTS,
      documentationUpdates: docPaths.map((docPath) => ({
        docPath,
        section: "S",
        suggestion: "update it",
        retrievedChunkId: null,
        sources: ["pr:1"],
        isPossibleDocDebt: false,
      })),
    });
  }

  it("computes PRIMARY precision/recall/F1 vs the curated gold", () => {
    // Recommend a.md (TP), b.md (TP), c.md (FP vs curated). Miss none.
    const result = docRecommendationAccuracy(recommend(["a.md", "b.md", "c.md"]), curated, gt);
    expect(result.primary.truePositives.sort()).toEqual(["a.md", "b.md"]);
    expect(result.primary.falsePositives).toEqual(["c.md"]);
    expect(result.primary.falseNegatives).toEqual([]);
    expect(result.primary.precision).toBeCloseTo(2 / 3);
    expect(result.primary.recall).toBe(1);
    expect(result.primary.f1).toBeCloseTo((2 * (2 / 3) * 1) / (2 / 3 + 1));
  });

  it("counts a missed gold doc as a false negative", () => {
    const result = docRecommendationAccuracy(recommend(["a.md"]), curated, gt);
    expect(result.primary.truePositives).toEqual(["a.md"]);
    expect(result.primary.falseNegatives).toEqual(["b.md"]);
    expect(result.primary.recall).toBe(0.5);
  });

  it("reports the changed-docs proxy as a recall LOWER BOUND, not precision", () => {
    // Recommend a.md (changed) and c.md (not changed). Proxy recall = 1 of 2
    // changed docs matched (a.md); z.md was never recommended.
    const result = docRecommendationAccuracy(recommend(["a.md", "c.md"]), curated, gt);
    expect(result.proxy.matchedChangedDocs).toEqual(["a.md"]);
    expect(result.proxy.recallLowerBound).toBe(0.5); // 1 of {a.md, z.md}
  });

  it("treats recommended-but-unchanged docs as possible doc debt, NOT errors", () => {
    // b.md is in the curated gold but NOT in changedDocPaths — a correct find
    // that diverges from the noisy proxy. It must surface as doc debt.
    const result = docRecommendationAccuracy(recommend(["a.md", "b.md"]), curated, gt);
    // a.md changed; b.md did not → exactly one possible-doc-debt path.
    expect(result.possibleDocDebtPaths).toEqual(["b.md"]);
    expect(result.possibleDocDebtCount).toBe(1);
    // And b.md is simultaneously a PRIMARY true positive — proving "diverges from
    // proxy" is not punished as a false positive.
    expect(result.primary.truePositives).toContain("b.md");
  });

  it("dedupes multiple suggestions for the same doc", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      documentationUpdates: [
        { docPath: "a.md", section: "S1", suggestion: "x", retrievedChunkId: null, sources: ["pr:1"], isPossibleDocDebt: false },
        { docPath: "a.md", section: "S2", suggestion: "y", retrievedChunkId: null, sources: ["pr:1"], isPossibleDocDebt: false },
      ],
    });
    const result = docRecommendationAccuracy(pkg, curated, gt);
    expect(result.recommended).toEqual(["a.md"]);
    expect(result.primary.truePositives).toEqual(["a.md"]);
  });
});

/* ============================================================================
 * (d) changelogRecall
 * ========================================================================== */

describe("changelogRecall", () => {
  // A small but representative ground truth: a couple of substantive PRs across
  // categories plus translation/internal noise that a good changelog omits.
  const gt = makeGroundTruth({
    releaseNotePrNumbers: [100, 200, 300, 400, 500, 600],
    releaseNotePrCategories: {
      "100": "Breaking Changes",
      "200": "Features",
      "300": "Fixes",
      "400": "Translations",
      "500": "Internal",
      "600": "Docs",
    },
  });

  /** Build a changelog whose entries cite the given PR numbers. */
  function changelogCiting(prNumbers: number[]): ReleasePackage {
    return makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: prNumbers.map((n) => ({
        category: "Features",
        text: `entry for ${n}`,
        sources: [`pr:${n}`],
      })),
    });
  }

  it("computes recall over SUBSTANTIVE categories as the headline", () => {
    // Cite the breaking change + feature + fix (all 3 substantive). Substantive
    // set = {100, 200, 300}; we cited all → recall 1.0.
    const result = changelogRecall(changelogCiting([100, 200, 300]), gt);
    expect(result.substantive.relevant.sort((a, b) => a - b)).toEqual([100, 200, 300]);
    expect(result.substantive.recall).toBe(1);
    expect(result.substantive.missed).toEqual([]);
  });

  it("does NOT penalize omitting translations/internal/docs in the substantive slice", () => {
    // Cite ONLY the substantive PRs; omit the translation/internal/docs PRs.
    const result = changelogRecall(changelogCiting([100, 200, 300]), gt);
    // Headline substantive recall is perfect even though 400/500/600 are absent.
    expect(result.substantive.recall).toBe(1);
    // Overall recall is lower by design (noise PRs correctly omitted).
    expect(result.overall.recall).toBeCloseTo(3 / 6);
  });

  it("reports per-category recall so a missed Breaking Change is visible", () => {
    // Miss the breaking change (100); cite the feature + fix.
    const result = changelogRecall(changelogCiting([200, 300]), gt);
    expect(result.byCategory["Breaking Changes"].recall).toBe(0);
    expect(result.byCategory["Breaking Changes"].missed).toEqual([100]);
    expect(result.byCategory["Features"].recall).toBe(1);
    expect(result.byCategory["Fixes"].recall).toBe(1);
    // The miss drags the substantive headline below 1.
    expect(result.substantive.recall).toBeCloseTo(2 / 3);
    expect(result.substantive.missed).toEqual([100]);
  });

  it("computes overall precision against the release-note union", () => {
    // Cite one real release-note PR (100) and one fabricated PR (9999) that is in
    // no release note → precision 1/2; recall counts only the real one.
    const result = changelogRecall(changelogCiting([100, 9999]), gt);
    expect(result.citedPrNumbers).toEqual([100, 9999]);
    expect(result.overall.precision).toBe(0.5);
  });

  it("ignores non-PR sources when parsing citations", () => {
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [
        { category: "Features", text: "x", sources: ["ticket:T-1", "commit:abc", "pr:200"] },
      ],
    });
    const result = changelogRecall(pkg, gt);
    expect(result.citedPrNumbers).toEqual([200]);
  });
});

/* ============================================================================
 * (e) runEval — aggregate
 * ========================================================================== */

describe("runEval", () => {
  it("aggregates every metric and derives validIds from the ReleaseInput", () => {
    const input = makeInput({ prNumbers: [200], ticketKeys: ["T-1"] });
    const gt = makeGroundTruth({
      releaseNotePrNumbers: [200],
      releaseNotePrCategories: { "200": "Features" },
      changedDocPaths: ["a.md"],
    });
    const curated = makeCurated(["a.md"]);

    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [{ category: "Features", text: "Add X", sources: ["pr:200", "ticket:T-1"] }],
      documentationUpdates: [
        { docPath: "a.md", section: "S", suggestion: "x", retrievedChunkId: null, sources: ["pr:200"], isPossibleDocDebt: false },
      ],
    });

    const report = runEval(pkg, input, gt, curated);

    // Hallucination: pr:200 and ticket:T-1 are valid (from the input) → rate 0.
    expect(report.hallucination.rate).toBe(0);
    // Ticket coverage: the one ticket is cited.
    expect(report.ticketCoverage).toEqual({ total: 1, covered: 1, missingTicketKeys: [] });
    // Doc rec: a.md is gold and recommended → perfect primary.
    expect(report.docRecommendation.primary.f1).toBe(1);
    // Changelog: the single substantive PR is cited → recall 1.
    expect(report.changelogRecall.substantive.recall).toBe(1);
    // The report carries the release ref through.
    expect(report.release.project).toBe("test/proj");
  });

  it("catches a fabricated citation end-to-end (validIds from the input)", () => {
    // The package cites pr:9999, which is NOT in the input → hallucination > 0.
    const input = makeInput({ prNumbers: [200], ticketKeys: [] });
    const gt = makeGroundTruth({});
    const curated = makeCurated([]);
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [{ category: "Features", text: "Fabricated", sources: ["pr:9999"] }],
    });

    const report = runEval(pkg, input, gt, curated);
    expect(report.hallucination.rate).toBe(1);
    expect(report.hallucination.flagged[0].badSources).toEqual(["pr:9999"]);
  });
});
