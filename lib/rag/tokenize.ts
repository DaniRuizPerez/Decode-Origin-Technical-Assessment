/**
 * Shared tokenizer for the lexical (BM25) and dense (embedding) paths.
 *
 * Both retrieval signals tokenize the same way on purpose: the comparison
 * between them in RRF is only meaningful if "what counts as a term" is
 * identical. The rules are deliberately simple and dependency-free (offline-
 * first): lowercase, split on non-alphanumerics, drop single characters.
 *
 * One domain-specific touch: identifiers like `include_router` are split on
 * `_` into `include` + `router`. A natural-language query ("include router")
 * should match the code identifier in the docs, and splitting both sides the
 * same way is what makes that hit land.
 */

/**
 * Split text into lowercased alphanumeric tokens.
 *
 * `_` is treated as a separator so `include_router` → `["include", "router"]`,
 * letting prose queries match snake_case code identifiers. Single-character
 * tokens are dropped as noise (they carry little topical signal and inflate
 * length normalization).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}
