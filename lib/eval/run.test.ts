import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReleasePackageSchema,
  type ReleaseArtifacts,
  type ReleasePackage,
} from "@/lib/schemas";

import { main, formatReport } from "./run";
import { runEval } from "./metrics";
import { getConnector, loadGroundTruth, loadCuratedGold } from "@/lib/connectors";

/**
 * The CLI is exercised against the REAL committed fixtures (the harvested FastAPI
 * window) — same philosophy as the connector tests — so it doubles as an
 * end-to-end smoke test that the eval wiring loads, validates, and prints without
 * throwing. We capture console output rather than asserting on exact numbers
 * (those live in metrics.test.ts), keeping this resilient to a re-harvest.
 */

const EMPTY_ARTIFACTS: ReleaseArtifacts = {
  changelog: [],
  internalReleaseNotes: [],
  customerReleaseNotes: [],
  documentationUpdates: [],
};

function makePackage(artifacts: ReleaseArtifacts): ReleasePackage {
  return ReleasePackageSchema.parse({
    release: { project: "test/proj", baseRef: "v1", headRef: "v2" },
    changeSet: { changes: [], unlinkedArtifactIds: [] },
    plan: {
      themes: [],
      affectedSystems: [],
      risk: { level: "low", reasons: [] },
      coverage: { total: 0, covered: 0, missingTicketKeys: [] },
    },
    artifacts,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatReport", () => {
  it("renders a full report against the real fixtures without throwing", () => {
    const input = getConnector().loadReleaseInput();
    const gt = loadGroundTruth();
    const curated = loadCuratedGold();

    // A package that cites the real breaking-change PR + its ticket, and
    // recommends one real curated-gold doc — so the printed report has content.
    const pkg = makePackage({
      ...EMPTY_ARTIFACTS,
      changelog: [
        { category: "Breaking Changes", text: "Router refactor", sources: ["pr:15745", "ticket:FAPI-1003"] },
      ],
      documentationUpdates: [
        {
          docPath: "tutorial__bigger-applications.md",
          section: "APIRouter",
          suggestion: "Update include_router examples",
          retrievedChunkId: null,
          sources: ["pr:15745"],
          isPossibleDocDebt: false,
        },
      ],
    });

    const report = runEval(pkg, input, gt, curated);
    const text = formatReport(report);

    // Spot-check the section headers are present and key labels render.
    expect(text).toContain("Eval report");
    expect(text).toContain("Hallucination");
    expect(text).toContain("Ticket coverage");
    expect(text).toContain("Doc-recommendation accuracy");
    expect(text).toContain("PRIMARY (vs curated gold)");
    expect(text).toContain("Changelog recall");
    expect(text).toContain("SUBSTANTIVE (headline)");
  });
});

describe("main()", () => {
  it("prints the ground-truth summary and exits 0 when no package is given", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // argv with no positional arg (argv[2] undefined).
    const code = main(["node", "eval"]);

    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("No ReleasePackage provided");
    expect(out).toContain("Ground truth");
    // The substantive-vs-noise split is part of the methodology we surface.
    expect(out).toContain("substantive");
  });

  it("scores a valid package read from disk and exits 0", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "eval-test-"));
    const pkgPath = join(dir, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify(
        makePackage({
          ...EMPTY_ARTIFACTS,
          changelog: [{ category: "Features", text: "x", sources: ["pr:15785"] }],
        }),
      ),
    );

    const code = main(["node", "eval", pkgPath]);
    expect(code).toBe(0);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("Eval report");
  });

  it("returns exit code 1 on a missing/unreadable package path", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = main(["node", "eval", "/nonexistent/path/to/package.json"]);
    expect(code).toBe(1);
    expect(err).toHaveBeenCalled();
  });

  it("returns exit code 1 on a malformed package (schema rejects it)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "eval-test-"));
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ not: "a release package" }));

    const code = main(["node", "eval", badPath]);
    expect(code).toBe(1);
    expect(err).toHaveBeenCalled();
  });
});
