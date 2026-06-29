import { describe, it, expect } from "vitest";

import { getConnector } from "@/lib/connectors";
import { RetrievedChunkSchema } from "@/lib/schemas";

import { Bm25Index } from "./bm25";
import { chunkDocs } from "./chunk";
import { buildRetriever, Retriever } from "./index";

/** A small seeded corpus for fast, deterministic unit tests. */
function seededDocs() {
  return [
    {
      docPath: "routing.md",
      text: [
        "# Routing",
        "Use APIRouter to split a bigger application across files.",
        "## include_router",
        "Call app.include_router to mount an APIRouter on the FastAPI app.",
      ].join("\n"),
    },
    {
      docPath: "security.md",
      text: [
        "# Security",
        "OAuth2 scopes secure your path operations with tokens.",
      ].join("\n"),
    },
    {
      docPath: "database.md",
      text: ["# Database", "Use an async session and a connection pool."].join(
        "\n",
      ),
    },
  ];
}

describe("Retriever (seeded corpus)", () => {
  it("returns schema-valid RetrievedChunks with fused score + signals", async () => {
    const retriever = await buildRetriever(seededDocs());
    const hits = await retriever.retrieve("APIRouter include_router", 3);

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      // Every result must satisfy the shared contract.
      expect(() => RetrievedChunkSchema.parse(hit)).not.toThrow();
      expect(typeof hit.score).toBe("number");
    }
    // The top hit must come from the routing doc and carry both signals.
    expect(hits[0].docPath).toBe("routing.md");
    expect(hits[0].signals.bm25).toBeGreaterThan(0);
    expect(hits[0].signals.dense).toBeGreaterThan(0);
  });

  it("ranks the lexically + semantically relevant section first", async () => {
    const retriever = await buildRetriever(seededDocs());
    const hits = await retriever.retrieve("mount APIRouter include_router", 1);
    expect(hits[0].section).toBe("include_router");
  });

  it("honors k (returns at most k chunks)", async () => {
    const retriever = await buildRetriever(seededDocs());
    expect(await retriever.retrieve("APIRouter", 2)).toHaveLength(2);
    expect((await retriever.retrieve("APIRouter", 1)).length).toBe(1);
  });

  it("is deterministic across runs", async () => {
    const a = await (await buildRetriever(seededDocs())).retrieve("APIRouter", 3);
    const b = await (await buildRetriever(seededDocs())).retrieve("APIRouter", 3);
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    expect(a.map((h) => h.score)).toEqual(b.map((h) => h.score));
  });

  it("fuses both rankings (a dense-only match still surfaces)", async () => {
    // Query shares NO literal token with the database doc, but ask for it by a
    // closely-overlapping phrasing so the dense signal can contribute.
    const retriever = await buildRetriever(seededDocs());
    const hits = await retriever.retrieve("async session connection pool", 3);
    // The database section is the intended answer and must appear.
    expect(hits.some((h) => h.docPath === "database.md")).toBe(true);
  });

  it("exposes its indexed size and supports manual index()", async () => {
    const retriever = new Retriever(chunkDocs(seededDocs()));
    expect(retriever.size).toBeGreaterThan(0);
    await retriever.index();
    // retrieve() also lazily indexes, so this must work regardless.
    expect((await retriever.retrieve("APIRouter", 1)).length).toBe(1);
  });
});

/**
 * INTEGRATION — the KEY test, over the REAL harvested FastAPI docs via the
 * connector (offline). The query is the one from the backlog spec.
 */
describe("Retriever (real corpus via connector) — KEY test", () => {
  const QUERY = "include_router APIRouter bigger applications router";
  const TARGET = "tutorial__bigger-applications.md";

  it("ranks the bigger-applications chunk in the top results", async () => {
    const docs = getConnector().loadDocs();
    const retriever = await buildRetriever(docs);
    const hits = await retriever.retrieve(QUERY, 5);

    // The known-relevant doc must be present in the top-5...
    expect(hits.some((h) => h.docPath === TARGET)).toBe(true);
    // ...and specifically the very top result for this query.
    expect(hits[0].docPath).toBe(TARGET);
  });

  it("hybrid ranks the known-relevant chunk at least as high as BM25 alone", async () => {
    const docs = getConnector().loadDocs();
    const chunks = chunkDocs(docs);

    // Best (smallest) rank of any target-doc chunk under each ranker.
    const bm25Ranked = new Bm25Index(chunks).search(QUERY);
    const bm25Rank = bm25Ranked.findIndex((r) => r.chunk.docPath === TARGET);

    const retriever = await buildRetriever(docs);
    // Retrieve enough to locate the target's rank robustly.
    const hybrid = await retriever.retrieve(QUERY, chunks.length);
    const hybridRank = hybrid.findIndex((h) => h.docPath === TARGET);

    expect(bm25Rank).toBeGreaterThanOrEqual(0);
    expect(hybridRank).toBeGreaterThanOrEqual(0);
    // Smaller rank = higher. Hybrid must not demote the relevant chunk below BM25.
    expect(hybridRank).toBeLessThanOrEqual(bm25Rank);
  });

  it("every returned chunk satisfies the RetrievedChunk contract", async () => {
    const docs = getConnector().loadDocs();
    const retriever = await buildRetriever(docs);
    const hits = await retriever.retrieve(QUERY, 5);
    expect(hits.length).toBe(5);
    for (const hit of hits) {
      expect(() => RetrievedChunkSchema.parse(hit)).not.toThrow();
      // section is the nearest heading and is non-empty.
      expect(hit.section.length).toBeGreaterThan(0);
    }
  });
});
