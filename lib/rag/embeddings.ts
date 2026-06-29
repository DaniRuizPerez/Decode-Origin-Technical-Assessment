/**
 * Dense embeddings — the semantic half of the hybrid retriever.
 *
 * The contract is an `EmbeddingProvider`: `embed(texts) → number[][]`. The
 * DEFAULT implementation is a deterministic, dependency-free "hashing
 * embedding" that runs fully offline with zero network. It is intentionally
 * simple but real enough to add signal:
 *
 *   - Tokenize (shared tokenizer, so lexical and dense agree on terms).
 *   - Hash each token into one of `dimension` buckets and accumulate a
 *     sublinear (`1 + ln tf`) weight — the bag-of-hashed-words / "hashing
 *     trick" used in classic IR when a learned vocabulary isn't available.
 *   - L2-normalize, so a dot product *is* cosine similarity and document
 *     length doesn't dominate.
 *
 * Why this is enough here: it captures token co-occurrence in a fixed-width
 * vector that's comparable across chunks, which is all RRF needs to fuse a
 * second ranking with BM25. It is *not* a learned semantic model — true
 * synonymy ("auth" ↔ "authentication") is out of scope for the deterministic
 * default. A learned model is available as an optional, env-gated upgrade
 * (`createTransformersEmbeddingProvider`) that we deliberately do NOT depend on
 * at runtime or in tests (offline-first); see the note on that function.
 *
 * Determinism is a hard requirement: the same text must embed to the same
 * vector on every machine and every run, so retrieval results — and any chunk
 * ids cited downstream — are reproducible. The hash is a fixed FNV-1a; there is
 * no randomness and no I/O.
 */

import { tokenize } from "./tokenize";

/**
 * The swappable dense-embedding boundary. `embed` maps a batch of texts to a
 * batch of fixed-dimension, L2-normalized vectors (same order as the input).
 * Batching mirrors how real embedding backends work (one call, many texts) so
 * an upgraded provider can amortize model cost without changing callers.
 */
export interface EmbeddingProvider {
  /** Vector dimensionality every returned embedding has. */
  readonly dimension: number;
  /** Human-readable id for traces/debugging (e.g. "hashing-256"). */
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** FNV-1a offset basis / prime (32-bit). A fixed, well-known hash → determinism. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a hash of a token to a 32-bit unsigned integer. Chosen over a random or
 * crypto hash because it is tiny, fast, and — crucially — fixed across runs and
 * platforms, which is what makes the embeddings reproducible.
 */
function fnv1a(token: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32-bit space (JS numbers are doubles).
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Coerce to unsigned 32-bit.
  return hash >>> 0;
}

/** Default vector width. 256 buckets is plenty to keep token collisions rare
 * on section-sized chunks while staying cheap to compute and store. */
const DEFAULT_DIMENSION = 256;

/**
 * Deterministic, offline hashing-embedding provider (the DEFAULT).
 *
 * Stateless and synchronous under the hood; the async signature exists only to
 * satisfy the `EmbeddingProvider` contract that an upgraded, genuinely-async
 * backend also implements.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly name: string;

  constructor(dimension: number = DEFAULT_DIMENSION) {
    this.dimension = dimension;
    this.name = `hashing-${dimension}`;
  }

  /** Embed one text into an L2-normalized vector (the workhorse). */
  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);

    // Accumulate term frequencies into hashed buckets.
    const tf = new Map<number, number>();
    for (const token of tokenize(text)) {
      const bucket = fnv1a(token) % this.dimension;
      tf.set(bucket, (tf.get(bucket) ?? 0) + 1);
    }

    // Sublinear TF weighting (1 + ln tf): like BM25's saturation, it stops a
    // token repeated many times from dominating the vector's direction.
    for (const [bucket, count] of tf) {
      vec[bucket] = 1 + Math.log(count);
    }

    // L2-normalize so dot product == cosine similarity. Empty text (no tokens)
    // stays an all-zero vector; we leave it as-is rather than dividing by zero.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }
}

/**
 * Cosine similarity of two equal-length vectors. Because the provider returns
 * L2-normalized vectors this is just the dot product, but we keep the name
 * explicit so call sites read clearly. Assumes equal length (same provider).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * The default provider used everywhere unless explicitly overridden. A single
 * factory keeps the "what do we embed with by default" decision in one place.
 */
export function defaultEmbeddingProvider(): EmbeddingProvider {
  return new HashingEmbeddingProvider();
}

/**
 * OPTIONAL, env-gated upgrade to a real learned model via `@xenova/transformers`
 * (all-MiniLM-L6-v2), loaded lazily and behind a try/catch.
 *
 * This is deliberately NOT wired into the default path, the retriever, or the
 * tests, for three reasons that all reduce to "offline-first, no surprises":
 *
 *   1. The package is an optional/heavy native dependency we do not commit to
 *      `package.json`; it must be installed and the model cached locally, both
 *      out of scope for the offline test suite.
 *   2. First use downloads model weights — a network call — which violates the
 *      no-network guarantee unless the caller has pre-cached them.
 *   3. It is non-deterministic across model versions, so tests must use the
 *      hashing default for stable assertions.
 *
 * It is gated on `process.env.RAG_EMBEDDINGS === "transformers"` and returns the
 * deterministic default if the dependency is missing or fails to load, so a
 * misconfigured environment degrades gracefully instead of crashing. Wiring a
 * real model end-to-end (with a committed model cache) is noted as future work.
 */
export async function createEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (process.env.RAG_EMBEDDINGS !== "transformers") {
    return defaultEmbeddingProvider();
  }
  try {
    // Dynamic import so the dependency is never required unless explicitly
    // opted into; the // @ts-expect-error documents that it's an optional dep
    // intentionally absent from the typed dependency graph.
    // @ts-expect-error optional peer dependency, not in package.json
    const mod = await import("@xenova/transformers");
    const pipeline = await mod.pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
    const DIMENSION = 384; // all-MiniLM-L6-v2 output width.
    return {
      dimension: DIMENSION,
      name: "xenova-all-MiniLM-L6-v2",
      async embed(texts: string[]): Promise<number[][]> {
        const out: number[][] = [];
        for (const text of texts) {
          const t = await pipeline(text, { pooling: "mean", normalize: true });
          out.push(Array.from(t.data as Float32Array));
        }
        return out;
      },
    };
  } catch {
    // Dependency missing or model load failed — fall back, don't crash.
    return defaultEmbeddingProvider();
  }
}
