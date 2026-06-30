/**
 * Source resolution — turns the opaque, namespaced citation ids carried on every
 * generated artifact (`commit:<sha>`, `pr:<number>`, `ticket:<key>`) into
 * human-readable, clickable evidence ({@link SourceRef}: title + GitHub url), and
 * the flattened `docPath`s carried on documentation updates / retrieval chunks
 * into clickable {@link DocRef}s (original repo path + GitHub blob url).
 *
 * WHY this lives in its own module (not in the connector or the pipeline):
 *  - It is a pure projection of already-loaded data (a `ReleaseInput` + cited ids,
 *    or the loaded docs + referenced docPaths) — no I/O — so it is trivially
 *    unit-testable against the real fixtures and reusable anywhere evidence is shown.
 *  - It resolves ONLY what's referenced (not the whole window of 250 commits / 158
 *    PRs, nor all 60 docs), so the resulting index stays as small as what the UI
 *    actually shows.
 *
 * URL construction mirrors GitHub's canonical paths for the release's project
 * (`input.release.project`, e.g. "fastapi/fastapi"):
 *   - PR     → https://github.com/<project>/pull/<number>
 *   - commit → https://github.com/<project>/commit/<full-sha>
 *   - ticket → null (reconstructed Jira-shaped tickets have no GitHub page)
 *   - doc    → https://github.com/<project>/blob/<ref>/<sourcePath> (from the
 *              harvested first-line `<!-- source: <path> @ <ref> -->` comment)
 *   - other  → null (unresolvable id; degrades gracefully)
 */

import type { DocRef, ReleaseInput, SourceRef } from "@/lib/schemas";

/** First line (subject) of a multi-line commit message, trimmed. */
function firstLine(message: string): string {
  const nl = message.indexOf("\n");
  return (nl === -1 ? message : message.slice(0, nl)).trim();
}

/**
 * Resolve the given cited ids against the loaded release input.
 *
 * @param input     The loaded release bundle (commits / pulls / tickets).
 * @param citedIds  The DISTINCT source ids actually cited by the artifacts.
 * @returns A map id → {@link SourceRef}. Every input id appears in the result;
 *          an id that doesn't match any known artifact resolves to
 *          `{ kind: "other", title: id, url: null }` so the UI never loses it.
 */
export function buildSourceIndex(
  input: ReleaseInput,
  citedIds: Iterable<string>,
): Record<string, SourceRef> {
  const project = input.release.project;

  // Build id → artifact lookups once so resolution is O(cited), not O(cited × N).
  const pullById = new Map(input.pullRequests.map((p) => [p.id, p]));
  const commitById = new Map(input.commits.map((c) => [c.id, c]));
  const ticketById = new Map(input.tickets.map((t) => [t.id, t]));

  const index: Record<string, SourceRef> = {};

  for (const id of citedIds) {
    if (index[id]) continue; // tolerate duplicate inputs cheaply

    if (id.startsWith("pr:")) {
      const pull = pullById.get(id);
      if (pull) {
        index[id] = {
          id,
          kind: "pr",
          title: pull.title,
          url: `https://github.com/${project}/pull/${pull.number}`,
        };
        continue;
      }
    } else if (id.startsWith("commit:")) {
      const commit = commitById.get(id);
      if (commit) {
        index[id] = {
          id,
          kind: "commit",
          title: firstLine(commit.message),
          // Full sha in the url even though the id carries the 7-char short sha.
          url: `https://github.com/${project}/commit/${commit.sha}`,
        };
        continue;
      }
    } else if (id.startsWith("ticket:")) {
      const ticket = ticketById.get(id);
      if (ticket) {
        index[id] = {
          id,
          kind: "ticket",
          title: ticket.summary,
          // Reconstructed Jira-shaped ticket — no external GitHub URL.
          url: null,
        };
        continue;
      }
    }

    // Unknown id, or a known prefix whose artifact isn't present: degrade.
    index[id] = { id, kind: "other", title: id, url: null };
  }

  return index;
}

/**
 * Matches the harvest provenance comment that `scripts/harvest.ts` writes as the
 * FIRST line of every doc file, e.g.
 *   `<!-- source: docs/en/docs/tutorial/bigger-applications.md @ 0.136.0 -->`
 * Capturing `sourcePath` (group 1) and `ref` (group 2). We parse the comment
 * rather than hardcoding an un-flatten rule, so the original path/ref survive
 * however the filename was flattened.
 */
const DOC_SOURCE_RE = /^<!--\s*source:\s*(.+?)\s*@\s*(.+?)\s*-->/;

/**
 * Resolve the given referenced docPaths against the loaded docs.
 *
 * @param docs                The loaded docs (`{ docPath, text }`), as from
 *                            `getConnector().loadDocs()`.
 * @param project             The release project, e.g. "fastapi/fastapi".
 * @param referencedDocPaths  The DISTINCT flattened docPaths actually referenced
 *                            by the documentation updates / retrieval chunks.
 * @returns A map docPath → {@link DocRef}. Every referenced docPath appears in the
 *          result; a doc that is missing, or whose first-line source comment is
 *          absent/unparseable, degrades to `{ sourcePath: docPath, url: null }` so
 *          the UI shows plain text rather than a broken link.
 */
export function buildDocIndex(
  docs: { docPath: string; text: string }[],
  project: string,
  referencedDocPaths: Iterable<string>,
): Record<string, DocRef> {
  // Build docPath → text lookup once so resolution is O(referenced), not O(N).
  const textByPath = new Map(docs.map((d) => [d.docPath, d.text]));

  const index: Record<string, DocRef> = {};

  for (const docPath of referencedDocPaths) {
    if (index[docPath]) continue; // tolerate duplicate references cheaply

    const text = textByPath.get(docPath);
    // First non-empty consideration: only the very first line carries the comment.
    const firstLine = text?.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
    const match = firstLine ? DOC_SOURCE_RE.exec(firstLine) : null;

    if (match) {
      const sourcePath = match[1];
      const ref = match[2];
      index[docPath] = {
        docPath,
        sourcePath,
        url: `https://github.com/${project}/blob/${ref}/${sourcePath}`,
      };
      continue;
    }

    // Missing doc, or a doc without a parseable source comment: degrade. The
    // flattened name is the best `sourcePath` we have, and there's no safe URL.
    index[docPath] = { docPath, sourcePath: docPath, url: null };
  }

  return index;
}
