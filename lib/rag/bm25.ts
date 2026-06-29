/**
 * Pure-TypeScript BM25 (Okapi) over a chunk corpus — the lexical half of the
 * hybrid retriever.
 *
 * BM25 is the lexical workhorse for a reason: it rewards rare query terms (IDF)
 * and saturates term frequency (a word appearing 50× isn't 50× as relevant),
 * with document-length normalization so a long section doesn't win on sheer
 * size. For release-doc retrieval the queries are full of exact identifiers
 * (`APIRouter`, `include_router`), and exact lexical overlap is precisely what
 * BM25 is best at — which is why we keep it as a first-class signal alongside
 * dense embeddings rather than relying on embeddings alone.
 *
 * Dependency-free and fully offline: the index is plain maps built from the
 * shared tokenizer. Scores are standard Okapi BM25 with the usual k1/b.
 */

import type { Chunk } from "./chunk";
import { tokenize } from "./tokenize";

/** One scored chunk from a BM25 query, highest score first when ranked. */
export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/** Okapi BM25 free parameters. The defaults are the textbook-standard values. */
export interface Bm25Params {
  /** Term-frequency saturation. Higher = TF matters more before plateauing. */
  k1: number;
  /** Length normalization strength in [0,1]. 0 = off, 1 = full. */
  b: number;
}

const DEFAULT_PARAMS: Bm25Params = { k1: 1.5, b: 0.75 };

/** Per-document precomputed state: token counts and length. */
interface DocStat {
  chunk: Chunk;
  /** term → frequency within this document. */
  tf: Map<string, number>;
  /** Total token count (document length), for length normalization. */
  length: number;
}

export class Bm25Index {
  private readonly docs: DocStat[] = [];
  /** term → number of documents containing it (for IDF). */
  private readonly df = new Map<string, number>();
  private avgDocLength = 0;
  private readonly params: Bm25Params;

  constructor(chunks: Chunk[], params: Partial<Bm25Params> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };

    let totalLength = 0;
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      // Document frequency counts each term once per doc, not per occurrence.
      for (const term of tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
      this.docs.push({ chunk, tf, length: tokens.length });
      totalLength += tokens.length;
    }

    // Guard the empty-corpus case so avgDocLength stays a finite number.
    this.avgDocLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  /** Number of indexed chunks. */
  get size(): number {
    return this.docs.length;
  }

  /**
   * Smoothed IDF — the standard BM25 variant:
   *   idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
   * The `1 +` keeps IDF non-negative even for terms in every document, so a
   * very common term contributes ~0 rather than dragging a score negative.
   */
  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Score every document against `query` and return them ranked highest-first.
   * Documents with zero query-term overlap score 0 and are dropped, so the
   * result contains only lexical matches (callers can read `length` to detect
   * "nothing matched").
   *
   * Ties break by chunk id to keep ordering deterministic across runs.
   */
  search(query: string): ScoredChunk[] {
    const { k1, b } = this.params;
    const queryTerms = tokenize(query);

    const results: ScoredChunk[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term);
        if (tf === undefined) continue; // term absent from this doc
        const idf = this.idf(term);
        // Okapi BM25 term contribution.
        const denom =
          tf + k1 * (1 - b + (b * doc.length) / (this.avgDocLength || 1));
        score += idf * ((tf * (k1 + 1)) / denom);
      }
      if (score > 0) {
        results.push({ chunk: doc.chunk, score });
      }
    }

    results.sort(
      (a, b2) => b2.score - a.score || a.chunk.id.localeCompare(b2.chunk.id),
    );
    return results;
  }
}
