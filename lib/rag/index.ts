/**
 * Public API of the hybrid RAG / retrieval layer.
 *
 * Downstream code (the Documentation Reviewer) should import from `@/lib/rag`
 * and use {@link buildRetriever} rather than wiring chunking + indexing by hand.
 * The pieces (chunk / bm25 / embeddings / retrieve) are exported too, for tests
 * and for callers that need finer control.
 */

import { chunkDocs } from "./chunk";
import { Retriever, type RetrieverOptions } from "./retrieve";

export { chunkDoc, chunkDocs, type Chunk } from "./chunk";
export { Bm25Index, type ScoredChunk, type Bm25Params } from "./bm25";
export { tokenize } from "./tokenize";
export {
  HashingEmbeddingProvider,
  defaultEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
  type EmbeddingProvider,
} from "./embeddings";
export { Retriever, type RetrieverOptions } from "./retrieve";

/**
 * Build a ready-to-query hybrid retriever from raw docs in one call: chunk →
 * index (BM25 + dense) → done.
 *
 * Takes `{ docPath, text }[]` — structurally exactly what the connector's
 * `loadDocs()` returns — so the typical call is `buildRetriever(getConnector().
 * loadDocs())`. Async because dense indexing embeds every chunk up front.
 *
 * @param docs    documents to index (e.g. from `getConnector().loadDocs()`)
 * @param options override the embedding provider or RRF constant
 */
export async function buildRetriever(
  docs: { docPath: string; text: string }[],
  options: RetrieverOptions = {},
): Promise<Retriever> {
  return Retriever.create(chunkDocs(docs), options);
}
