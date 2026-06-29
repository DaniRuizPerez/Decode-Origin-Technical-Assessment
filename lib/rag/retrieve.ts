/**
 * Hybrid retriever — fuses lexical (BM25) and dense (embedding) rankings via
 * Reciprocal Rank Fusion (RRF) and returns schema-validated `RetrievedChunk`s.
 *
 * WHY HYBRID. The two signals fail in different, complementary ways:
 *
 *   - BM25 nails exact tokens (`APIRouter`, `include_router`) but is blind to
 *     wording it hasn't literally seen.
 *   - Dense embeddings capture distributional/topical similarity but can be
 *     fuzzy on rare identifiers and short queries.
 *
 * Release-doc queries mix code identifiers with prose, so neither alone is
 * reliable. Fusing them keeps a chunk that *either* method is confident about,
 * which is empirically more robust than tuning a single ranker.
 *
 * WHY RRF (not score-weighting). BM25 scores are unbounded; cosine sims live in
 * [-1,1]. Combining them by value forces an arbitrary, fragile normalization.
 * RRF instead fuses *ranks*: each list contributes 1/(k + rank), so only the
 * order matters. It's parameter-light (one constant `k`), scale-free, and the
 * standard choice for combining heterogeneous retrievers. `k` (default 60, the
 * value from the original RRF paper) damps the influence of low ranks so the
 * top of each list dominates without any single list being able to veto a
 * chunk the other ranks highly.
 */

import { RetrievedChunkSchema, type RetrievedChunk } from "@/lib/schemas";

import { Bm25Index } from "./bm25";
import type { Chunk } from "./chunk";
import {
  cosineSimilarity,
  defaultEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings";

/** RRF damping constant from Cormack et al. 2009 — higher = flatter weighting. */
const DEFAULT_RRF_K = 60;

/** A chunk paired with its dense (cosine) score, ranked highest-first. */
interface DenseScored {
  chunk: Chunk;
  score: number;
}

/** Accumulator while fusing the two ranked lists per chunk. */
interface FusionEntry {
  chunk: Chunk;
  fused: number;
  bm25?: number;
  dense?: number;
}

export interface RetrieverOptions {
  /** Dense embedding backend. Defaults to the deterministic hashing provider. */
  embeddingProvider?: EmbeddingProvider;
  /** RRF damping constant. */
  rrfK?: number;
}

/**
 * Indexes a chunk corpus under both signals and answers hybrid queries.
 *
 * Construction is split from indexing because embedding is async (an upgraded
 * provider does real model work): call {@link create} to get a ready Retriever,
 * or `new Retriever(...)` then `await index()` if you need to control timing.
 */
export class Retriever {
  private readonly chunks: Chunk[];
  private readonly bm25: Bm25Index;
  private readonly embeddings: EmbeddingProvider;
  private readonly rrfK: number;

  /** chunk index → its document embedding. Populated by {@link index}. */
  private docVectors: number[][] = [];
  private indexed = false;

  constructor(chunks: Chunk[], options: RetrieverOptions = {}) {
    this.chunks = chunks;
    this.bm25 = new Bm25Index(chunks);
    this.embeddings = options.embeddingProvider ?? defaultEmbeddingProvider();
    this.rrfK = options.rrfK ?? DEFAULT_RRF_K;
  }

  /** Build a fully-indexed retriever in one step (the common path). */
  static async create(
    chunks: Chunk[],
    options: RetrieverOptions = {},
  ): Promise<Retriever> {
    const r = new Retriever(chunks, options);
    await r.index();
    return r;
  }

  /** Number of indexed chunks. */
  get size(): number {
    return this.chunks.length;
  }

  /**
   * Embed every chunk once and cache the vectors. BM25 is already indexed in
   * the constructor (synchronous); this is the async half. Idempotent.
   */
  async index(): Promise<void> {
    if (this.indexed) return;
    this.docVectors = await this.embeddings.embed(
      this.chunks.map((c) => c.text),
    );
    this.indexed = true;
  }

  /** Rank all chunks by dense cosine similarity to the query, highest-first. */
  private async denseSearch(query: string): Promise<DenseScored[]> {
    const [queryVec] = await this.embeddings.embed([query]);
    const scored = this.chunks.map((chunk, i) => ({
      chunk,
      score: cosineSimilarity(queryVec, this.docVectors[i]),
    }));
    // Keep only positive similarity; an orthogonal chunk carries no signal.
    // Tie-break by id for deterministic ordering (mirrors BM25).
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  }

  /**
   * Hybrid retrieve: fuse BM25 and dense rankings with RRF, return the top `k`
   * as validated `RetrievedChunk`s. Each carries the raw per-signal scores in
   * `signals` (for explainability/debugging) and the fused RRF value as `score`.
   *
   * @param query free text (identifiers + prose both welcome)
   * @param k     number of chunks to return (default 5)
   */
  async retrieve(query: string, k = 5): Promise<RetrievedChunk[]> {
    if (!this.indexed) await this.index();

    const bm25Ranked = this.bm25.search(query);
    const denseRanked = await this.denseSearch(query);

    // Fuse by rank. Keyed by chunk id so a chunk appearing in both lists is
    // merged into one entry whose RRF contributions sum.
    const fusion = new Map<string, FusionEntry>();

    const fold = (
      ranked: { chunk: Chunk; score: number }[],
      signal: "bm25" | "dense",
    ) => {
      ranked.forEach(({ chunk, score }, rank) => {
        const entry = fusion.get(chunk.id) ?? {
          chunk,
          fused: 0,
          bm25: undefined,
          dense: undefined,
        };
        // RRF: position in this list (0-based rank → +1) contributes 1/(k+rank).
        entry.fused += 1 / (this.rrfK + rank + 1);
        entry[signal] = score;
        fusion.set(chunk.id, entry);
      });
    };

    fold(bm25Ranked, "bm25");
    fold(denseRanked, "dense");

    // Highest fused score first; deterministic id tie-break.
    const ordered = [...fusion.values()].sort(
      (a, b) => b.fused - a.fused || a.chunk.id.localeCompare(b.chunk.id),
    );

    return ordered.slice(0, k).map((entry) =>
      // Validate on the way out so consumers get a value already proven to
      // satisfy the shared `RetrievedChunk` contract.
      RetrievedChunkSchema.parse({
        id: entry.chunk.id,
        docPath: entry.chunk.docPath,
        section: entry.chunk.section,
        text: entry.chunk.text,
        score: entry.fused,
        signals: {
          ...(entry.bm25 !== undefined ? { bm25: entry.bm25 } : {}),
          ...(entry.dense !== undefined ? { dense: entry.dense } : {}),
        },
      }),
    );
  }
}
