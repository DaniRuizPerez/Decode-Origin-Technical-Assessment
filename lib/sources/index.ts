/**
 * Source resolution — turns the opaque, namespaced citation ids carried on every
 * generated artifact (`commit:<sha>`, `pr:<number>`, `ticket:<key>`) into
 * human-readable, clickable evidence ({@link SourceRef}: title + GitHub url).
 *
 * WHY this lives in its own module (not in the connector or the pipeline):
 *  - It is a pure projection of an already-loaded `ReleaseInput` plus a set of
 *    cited ids — no I/O — so it is trivially unit-testable against the real
 *    fixtures and reusable anywhere a citation needs to be displayed.
 *  - It resolves ONLY the cited ids (not the whole window of 250 commits / 158
 *    PRs), so the resulting `sourceIndex` stays as small as the evidence the UI
 *    actually shows.
 *
 * URL construction mirrors GitHub's canonical paths for the release's project
 * (`input.release.project`, e.g. "fastapi/fastapi"):
 *   - PR     → https://github.com/<project>/pull/<number>
 *   - commit → https://github.com/<project>/commit/<full-sha>
 *   - ticket → null (reconstructed Jira-shaped tickets have no GitHub page)
 *   - other  → null (unresolvable id; degrades gracefully)
 */

import type { ReleaseInput, SourceRef } from "@/lib/schemas";

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
