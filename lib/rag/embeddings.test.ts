import { describe, it, expect } from "vitest";

import {
  HashingEmbeddingProvider,
  defaultEmbeddingProvider,
  cosineSimilarity,
} from "./embeddings";

const L2 = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("HashingEmbeddingProvider (deterministic default)", () => {
  const provider = new HashingEmbeddingProvider();

  it("produces fixed-dimension vectors", async () => {
    const [v] = await provider.embed(["APIRouter include_router"]);
    expect(v).toHaveLength(provider.dimension);
    expect(provider.dimension).toBe(256);
  });

  it("L2-normalizes every non-empty vector to unit length", async () => {
    const vecs = await provider.embed([
      "a short doc",
      "a much longer document with many more tokens repeated repeated repeated",
    ]);
    for (const v of vecs) {
      expect(L2(v)).toBeCloseTo(1, 6);
    }
  });

  it("is deterministic: identical text → identical vector across runs", async () => {
    const a = await provider.embed(["include_router APIRouter"]);
    const b = await provider.embed(["include_router APIRouter"]);
    expect(a[0]).toEqual(b[0]);
    // A second provider instance must agree too (no hidden per-instance state).
    const c = await new HashingEmbeddingProvider().embed([
      "include_router APIRouter",
    ]);
    expect(c[0]).toEqual(a[0]);
  });

  it("gives near-identical text a high cosine similarity", async () => {
    const [a, b] = await provider.embed([
      "APIRouter include_router bigger applications",
      "APIRouter include_router bigger applications router",
    ]);
    // Heavy token overlap → strong similarity.
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.8);
  });

  it("gives unrelated text a low cosine similarity", async () => {
    const [a, b] = await provider.embed([
      "APIRouter include_router bigger applications",
      "oauth2 scopes security tokens authentication",
    ]);
    // Disjoint vocabulary → near-orthogonal (allowing rare hash collisions).
    expect(cosineSimilarity(a, b)).toBeLessThan(0.2);
  });

  it("self-similarity is 1 (unit vectors)", async () => {
    const [a] = await provider.embed(["any document text here"]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  it("embeds empty text as an all-zero vector (no divide-by-zero)", async () => {
    const [v] = await provider.embed([""]);
    expect(v).toHaveLength(provider.dimension);
    expect(v.every((x) => x === 0)).toBe(true);
    // Cosine against anything is 0, i.e. it carries no signal rather than NaN.
    const [other] = await provider.embed(["real content"]);
    expect(cosineSimilarity(v, other)).toBe(0);
  });

  it("respects a custom dimension and names itself accordingly", async () => {
    const p = new HashingEmbeddingProvider(64);
    expect(p.dimension).toBe(64);
    expect(p.name).toBe("hashing-64");
    const [v] = await p.embed(["text"]);
    expect(v).toHaveLength(64);
  });
});

describe("defaultEmbeddingProvider", () => {
  it("returns the deterministic hashing provider", () => {
    const p = defaultEmbeddingProvider();
    expect(p.name).toBe("hashing-256");
  });
});
