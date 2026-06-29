/**
 * Markdown chunking — the first stage of the retrieval pipeline.
 *
 * Splits a documentation file into heading-delimited chunks, one per section.
 * "Section" is the right granularity for *this* product: the Documentation
 * Reviewer suggests edits at the section level (see `DocUpdateSchema.section`),
 * so retrieving section-sized chunks means a hit already names the exact place a
 * suggestion would target — no second pass to localize within a doc.
 *
 * Design choices worth calling out:
 *
 *  - **Fence-aware.** A markdown heading is a `#`-prefixed line, but `#` also
 *    starts comments inside fenced code blocks (the FastAPI docs literally have
 *    `# this file makes "app" a "Python package"` inside a ``` block). We track
 *    fence state and only treat `#` lines *outside* a fence as headings, so code
 *    comments never spuriously split a section.
 *  - **Anchor suffixes stripped.** These docs tag headings with an explicit
 *    anchor, e.g. `## `APIRouter` { #apirouter }`. The trailing `{ #... }` is
 *    machinery, not prose, so we strip it from the human-readable `section`.
 *  - **Stable ids.** A chunk id is derived from `docPath + section + index`, so
 *    it is reproducible across runs (no hashing of volatile text) and stays
 *    unique even when two sections share a heading (the index disambiguates).
 *    Downstream artifacts cite chunks by id, so stability is a contract concern.
 */

/** A heading-delimited slice of one document. */
export interface Chunk {
  /** Stable, reproducible id: `${docPath}#${index}:${slug(section)}`. */
  id: string;
  /** Bare doc filename, carried through from the connector's `LoadedDoc`. */
  docPath: string;
  /** Nearest preceding heading text (anchor suffix stripped). */
  section: string;
  /** The section body, including its heading line, trimmed. */
  text: string;
}

/** A markdown ATX heading line, e.g. `### Import `APIRouter``. */
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Trailing explicit-anchor syntax used throughout the FastAPI docs:
 * `## `APIRouter` { #apirouter }`. We drop it from the displayed section text.
 */
const ANCHOR_SUFFIX_RE = /\s*\{\s*#[^}]*\}\s*$/;

/** Opening/closing of a fenced code block: ``` or ~~~ (optionally indented). */
const FENCE_RE = /^\s*(```+|~~~+)/;

/**
 * Section text used before the first heading (a preamble, or a doc with no
 * headings at all). Kept as its own chunk so no content is silently dropped.
 */
const PREAMBLE_SECTION = "(preamble)";

/**
 * Slugify a heading into an id-safe token. Lowercase, non-alphanumerics → `-`,
 * collapsed and trimmed. Used only for the chunk id; the human-readable heading
 * is preserved verbatim in `section`.
 */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Split one markdown document into heading-delimited chunks.
 *
 * Every line up to (but not including) the next heading belongs to the current
 * section, including the heading line itself — keeping the heading in `text`
 * means BM25/embeddings see the section title, which is usually its strongest
 * topical signal. Empty sections (a heading immediately followed by another)
 * still produce a chunk so the section is retrievable and citable.
 *
 * @param docPath bare filename (as produced by the connector's `LoadedDoc`)
 * @param text    raw markdown
 */
export function chunkDoc(docPath: string, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);

  const chunks: Chunk[] = [];
  let currentSection = PREAMBLE_SECTION;
  let buffer: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  // Emit the accumulated buffer as a chunk, then reset for the next section.
  const flush = () => {
    const body = buffer.join("\n").trim();
    // Drop a truly empty leading preamble (common: file starts at a heading),
    // but keep empty *named* sections so every heading stays citable.
    if (body.length === 0 && currentSection === PREAMBLE_SECTION) {
      buffer = [];
      return;
    }
    const index = chunks.length;
    chunks.push({
      id: `${docPath}#${index}:${slug(currentSection)}`,
      docPath,
      section: currentSection,
      text: body,
    });
    buffer = [];
  };

  for (const line of lines) {
    // Toggle fence state first. A line that opens/closes a fence is body text,
    // never a heading, so we record it and move on.
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1][0]; // "`" or "~"
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        // Only a matching fence type closes the block (``` doesn't close ~~~).
        inFence = false;
        fenceMarker = "";
      }
      buffer.push(line);
      continue;
    }

    const heading = inFence ? null : line.match(HEADING_RE);
    if (heading) {
      // A new heading ends the previous section and starts a fresh one.
      flush();
      currentSection = heading[2].replace(ANCHOR_SUFFIX_RE, "").trim();
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }

  flush();
  return chunks;
}

/**
 * Chunk a batch of loaded docs into one flat corpus. Convenience for the
 * retriever, which indexes across every document at once.
 */
export function chunkDocs(docs: { docPath: string; text: string }[]): Chunk[] {
  return docs.flatMap((d) => chunkDoc(d.docPath, d.text));
}
