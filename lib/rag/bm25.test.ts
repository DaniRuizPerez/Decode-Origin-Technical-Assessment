import { describe, it, expect } from "vitest";

import { Bm25Index } from "./bm25";
import type { Chunk } from "./chunk";

/** Build a tiny seeded corpus of chunks for deterministic unit tests. */
function corpus(): Chunk[] {
  const sections: Array<[string, string]> = [
    ["routing", "APIRouter lets you include_router into a bigger application."],
    ["database", "Connect to a database with an async session and a pool."],
    ["security", "OAuth2 scopes secure your path operations with tokens."],
    ["testing", "Use the TestClient to write tests for your endpoints."],
  ];
  return sections.map(([section, text], i) => ({
    id: `d.md#${i}:${section}`,
    docPath: "d.md",
    section,
    text,
  }));
}

describe("Bm25Index", () => {
  it("ranks the lexically-matching chunk first", () => {
    const index = new Bm25Index(corpus());
    const results = index.search("APIRouter include_router application");

    expect(results.length).toBeGreaterThan(0);
    // The routing chunk is the only one mentioning these terms — it must win.
    expect(results[0].chunk.section).toBe("routing");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns only chunks with query-term overlap (drops zero-score docs)", () => {
    const index = new Bm25Index(corpus());
    const results = index.search("database session pool");
    // Only the database chunk overlaps; the other three score 0 and are dropped.
    expect(results).toHaveLength(1);
    expect(results[0].chunk.section).toBe("database");
  });

  it("returns nothing for a query with no overlapping terms", () => {
    const index = new Bm25Index(corpus());
    expect(index.search("kubernetes helm chart")).toEqual([]);
  });

  it("rewards rarer terms via IDF", () => {
    // 'common' is in every doc (IDF≈0); 'unicorn' is in exactly one (high IDF).
    const chunks: Chunk[] = [
      { id: "a", docPath: "d", section: "a", text: "common common unicorn" },
      { id: "b", docPath: "d", section: "b", text: "common common common" },
      { id: "c", docPath: "d", section: "c", text: "common alpha" },
    ];
    const index = new Bm25Index(chunks);
    const results = index.search("common unicorn");
    // Doc 'a' wins on the rare 'unicorn' term, not on raw 'common' frequency.
    expect(results[0].chunk.id).toBe("a");
  });

  it("is deterministic and tie-breaks by chunk id", () => {
    // Two identical-text chunks → identical scores → stable id ordering.
    const chunks: Chunk[] = [
      { id: "z", docPath: "d", section: "z", text: "router router" },
      { id: "a", docPath: "d", section: "a", text: "router router" },
    ];
    const index = new Bm25Index(chunks);
    const results = index.search("router");
    expect(results.map((r) => r.chunk.id)).toEqual(["a", "z"]);
  });

  it("reports the indexed size and tolerates an empty corpus", () => {
    expect(new Bm25Index(corpus()).size).toBe(4);
    const empty = new Bm25Index([]);
    expect(empty.size).toBe(0);
    expect(empty.search("anything")).toEqual([]);
  });
});
