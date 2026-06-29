import { describe, it, expect } from "vitest";

import {
  getConnector,
  MockConnector,
  findUnlinkedArtifactIds,
  loadGroundTruth,
  loadCuratedGold,
  type Connector,
} from "./index";

/**
 * These tests run against the REAL committed fixtures in `data/mocks/` (the
 * harvested FastAPI 0.136.0…0.137.2 window), not synthetic data. They therefore
 * double as a contract check: if a re-harvest produces JSON the schemas reject,
 * or shifts the well-known counts, these fail loudly. Counts come from the
 * backlog spec and were confirmed against the fixtures.
 */
describe("MockConnector ingestion layer", () => {
  const connector: Connector = getConnector();

  describe("loadReleaseInput()", () => {
    const input = connector.loadReleaseInput();

    it("loads and zod-validates the real release bundle (250/158/7)", () => {
      expect(input.commits).toHaveLength(250);
      expect(input.pullRequests).toHaveLength(158);
      expect(input.tickets).toHaveLength(7);
    });

    it("carries the release window reference", () => {
      expect(input.release.project).toBe("fastapi/fastapi");
      expect(input.release.baseRef).toBe("0.136.0");
      expect(input.release.headRef).toBe("0.137.2");
    });

    it("namespaces artifact ids so citations are uniform", () => {
      // The schema contract relies on `commit:`/`pr:`/`ticket:` prefixes.
      expect(input.commits.every((c) => c.id.startsWith("commit:"))).toBe(true);
      expect(input.pullRequests.every((p) => p.id.startsWith("pr:"))).toBe(true);
      expect(input.tickets.every((t) => t.id.startsWith("ticket:"))).toBe(true);
    });
  });

  describe("loadDocs()", () => {
    const docs = connector.loadDocs();

    it("returns all 60 docs", () => {
      expect(docs).toHaveLength(60);
    });

    it("exposes docPath as the bare flattened filename", () => {
      const paths = docs.map((d) => d.docPath);
      expect(paths).toContain("tutorial__bigger-applications.md");
      // Bare filename, not a path — this is what the gold sets join on.
      expect(paths.every((p) => !p.includes("/"))).toBe(true);
    });

    it("loads non-empty text for each doc", () => {
      expect(docs.every((d) => d.text.length > 0)).toBe(true);
    });
  });

  describe("loadGroundTruth() + loadCuratedGold()", () => {
    it("parses & validates ground truth", () => {
      const gt = loadGroundTruth();
      expect(gt.release.project).toBe("fastapi/fastapi");
      // Real harvested signals are present (weak proxy, but should be populated).
      expect(gt.changedDocPaths.length).toBeGreaterThan(0);
      expect(gt.releaseNotePrNumbers.length).toBeGreaterThan(0);
    });

    it("parses curated gold with exactly 3 impacted docs", () => {
      const gold = loadCuratedGold();
      expect(gold.impactedDocs).toHaveLength(3);
      expect(gold.impactedDocs.map((d) => d.docPath)).toContain(
        "tutorial__bigger-applications.md",
      );
      // Every label carries a rationale tying it to the responsible change.
      expect(gold.impactedDocs.every((d) => d.rationale.length > 0)).toBe(true);
    });
  });

  describe("findUnlinkedArtifactIds()", () => {
    const input = connector.loadReleaseInput();
    const unlinked = findUnlinkedArtifactIds(input);

    it("returns >100 unlinked artifact ids (most FastAPI PRs are ticketless)", () => {
      expect(unlinked.length).toBeGreaterThan(100);
    });

    it("excludes every PR that DOES have a linked ticket", () => {
      const unlinkedSet = new Set(unlinked);
      const ticketedPrIds = input.pullRequests
        .filter((pr) => pr.ticketKeys.length > 0)
        .map((pr) => pr.id);

      // The 7 ticketed PRs are the linkage backbone — none may be flagged unlinked.
      expect(ticketedPrIds).toHaveLength(7);
      for (const id of ticketedPrIds) {
        expect(unlinkedSet.has(id)).toBe(false);
      }
    });

    it("flags only artifacts whose ticketKeys are empty", () => {
      const byId = new Map([
        ...input.pullRequests.map((p) => [p.id, p.ticketKeys] as const),
        ...input.commits.map((c) => [c.id, c.ticketKeys] as const),
      ]);
      for (const id of unlinked) {
        expect(byId.get(id)).toEqual([]);
      }
    });
  });

  describe("public API surface", () => {
    it("getConnector() returns something satisfying the Connector port", () => {
      const c = getConnector();
      expect(typeof c.loadReleaseInput).toBe("function");
      expect(typeof c.loadDocs).toBe("function");
    });

    it("MockConnector accepts an explicit root dir", () => {
      // Constructor injection keeps the adapter testable without env juggling.
      const c = new MockConnector(process.cwd());
      expect(c.loadDocs().length).toBe(60);
    });
  });
});
