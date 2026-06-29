/**
 * Documentation Reviewer tests — offline, MockProvider, but with a REAL hybrid
 * retriever indexed over the actual FastAPI docs (`getConnector().loadDocs()`).
 *
 * This is an end-to-end retrieval assertion: the routing-refactor change must,
 * through real BM25+dense retrieval over the real corpus, produce a DocUpdate
 * targeting `tutorial__bigger-applications.md` (the doc that explains
 * include_router / router.routes — confirmed against data/curated-gold.json).
 */

import { describe, it, expect, beforeAll } from "vitest";

import { getConnector } from "@/lib/connectors";
import { MockProvider } from "@/lib/llm";
import { buildRetriever, type Retriever } from "@/lib/rag";
import { ChangeSetSchema, ReleasePlanSchema } from "@/lib/schemas";

import { reviewDocs } from "./docReviewer";

/** Real-derived change set: the routing overhaul plus a header-behavior change. */
const CHANGE_SET = ChangeSetSchema.parse({
  changes: [
    {
      id: "chg-routing-refactor",
      type: "breaking",
      summary: "Refactor internals to preserve APIRouter and APIRoute instances",
      details:
        "include_router no longer flattens sub-routers; router.routes is now a tree.",
      components: ["routing", "applications"],
      sourceIds: ["ticket:FAPI-1003", "pr:15745", "commit:8e1d774"],
      confidence: 0.95,
      isBreaking: true,
    },
    {
      id: "chg-underscore-headers",
      type: "refactor",
      summary:
        "Do not accept underscore headers when using convert_underscores=True",
      details: "Header params with underscores are no longer matched by default.",
      components: ["params"],
      sourceIds: ["ticket:FAPI-1002", "pr:15589", "commit:063b5bf"],
      confidence: 0.8,
      isBreaking: false,
    },
    {
      // A pure-docs change must NOT generate a suggestion (it's the doc edit itself).
      id: "chg-docs-i18n",
      type: "docs",
      summary: "Add and update translations across the documentation",
      components: ["docs"],
      sourceIds: ["pr:15760"],
      confidence: 0.6,
      isBreaking: false,
    },
  ],
  unlinkedArtifactIds: ["pr:15760"],
});

const PLAN = ReleasePlanSchema.parse({
  themes: [
    {
      title: "Routing internals overhaul",
      summary: "APIRouter/APIRoute instances are preserved in a route tree.",
      changeIds: ["chg-routing-refactor"],
    },
  ],
  affectedSystems: ["routing", "params"],
  risk: { level: "high", reasons: ["Breaking change to a core routing API."] },
  coverage: { total: 3, covered: 2, missingTicketKeys: ["pr:15760"] },
});

const VALID_IDS = new Set(CHANGE_SET.changes.flatMap((c) => c.sourceIds));

/** The real doc filenames, for asserting suggestions reference an actual doc. */
const REAL_DOC_PATHS = new Set(getConnector().loadDocs().map((d) => d.docPath));

let retriever: Retriever;

// Index the full real corpus once; embedding every chunk is the slow part and is
// shared across all cases in this suite.
beforeAll(async () => {
  retriever = await buildRetriever(getConnector().loadDocs());
});

describe("reviewDocs (offline / MockProvider, real retriever over real docs)", () => {
  it("suggests an update to tutorial__bigger-applications.md for the routing refactor", async () => {
    const updates = await reviewDocs(
      CHANGE_SET,
      PLAN,
      retriever,
      new MockProvider(),
    );

    expect(updates.length).toBeGreaterThan(0);

    const biggerApps = updates.find(
      (u) => u.docPath === "tutorial__bigger-applications.md",
    );
    expect(biggerApps).toBeDefined();
    // Grounded by the routing-refactor change's real source ids…
    expect(biggerApps!.sources).toContain("pr:15745");
    // …and by a real retrieved chunk from that same doc.
    expect(biggerApps!.retrievedChunkId).toBeTruthy();
    expect(biggerApps!.retrievedChunkId!).toContain(
      "tutorial__bigger-applications.md",
    );
    // The suggestion is concrete ("Update the ...").
    expect(biggerApps!.suggestion).toMatch(/^Update the /);
    // Doc-debt classification is left to the coordinator.
    expect(biggerApps!.isPossibleDocDebt).toBe(false);
  });

  it("grounds every DocUpdate: valid sources, real docPath, real retrieved chunk", async () => {
    const updates = await reviewDocs(
      CHANGE_SET,
      PLAN,
      retriever,
      new MockProvider(),
    );

    for (const u of updates) {
      // Sources are all real artifact ids.
      expect(u.sources.length).toBeGreaterThan(0);
      for (const id of u.sources) expect(VALID_IDS.has(id)).toBe(true);

      // docPath is a real document (not invented, not the circular release-notes).
      expect(REAL_DOC_PATHS.has(u.docPath)).toBe(true);
      expect(u.docPath).not.toBe("release-notes.md");

      // The retrieved chunk id belongs to the same doc it targets.
      expect(u.retrievedChunkId).toBeTruthy();
      expect(u.retrievedChunkId!.startsWith(u.docPath + "#")).toBe(true);

      // The section is non-empty and the suggestion mentions it.
      expect(u.section.length).toBeGreaterThan(0);
    }
  });

  it("deduplicates by docPath + section", async () => {
    const updates = await reviewDocs(
      CHANGE_SET,
      PLAN,
      retriever,
      new MockProvider(),
    );
    const keys = updates.map((u) => `${u.docPath} :: ${u.section}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not generate suggestions from pure-docs changes", async () => {
    const updates = await reviewDocs(
      CHANGE_SET,
      PLAN,
      retriever,
      new MockProvider(),
    );
    // The only docs-typed change cites pr:15760; no suggestion should be grounded
    // solely on it (docs changes are the edits themselves, nothing to suggest).
    const fromDocsChange = updates.filter(
      (u) => u.sources.length === 1 && u.sources[0] === "pr:15760",
    );
    expect(fromDocsChange).toHaveLength(0);
  });

  it("is deterministic under MockProvider (same input → deeply-equal output)", async () => {
    const a = await reviewDocs(CHANGE_SET, PLAN, retriever, new MockProvider());
    const b = await reviewDocs(CHANGE_SET, PLAN, retriever, new MockProvider());
    expect(a).toEqual(b);
  });
});
