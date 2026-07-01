"use client";

/**
 * Changelog, grouped by category, with per-entry source evidence.
 *
 * WHY client: in edit mode each entry's text becomes an editable <textarea>
 * bound to the dashboard's local draft state (see Dashboard). The grouping is
 * derived at render time so it always reflects the current entries — including
 * any the pipeline emits later — rather than a precomputed structure.
 */

import { useState } from "react";

import type { ChangelogEntry } from "@/lib/schemas";
import { SourceEvidence } from "./SourceEvidence";
import { useSourceIndex } from "./SourceIndexContext";
import { Panel } from "./ui";

/**
 * Group entries by category while preserving first-seen order. WHY preserve
 * order: the writer emits categories in a meaningful sequence (Breaking →
 * Features → Fixes …); a Map keyed by category keeps that order stable.
 */
function groupByCategory(
  entries: ChangelogEntry[],
): Array<{ category: string; items: Array<{ entry: ChangelogEntry; index: number }> }> {
  const map = new Map<string, Array<{ entry: ChangelogEntry; index: number }>>();
  entries.forEach((entry, index) => {
    const bucket = map.get(entry.category);
    if (bucket) bucket.push({ entry, index });
    else map.set(entry.category, [{ entry, index }]);
  });
  return Array.from(map, ([category, items]) => ({ category, items }));
}

/**
 * Collapsible "N files changed" for a changelog entry: the union of the files its
 * cited PRs/commits touched (resolved via the package's `sourceIndex`), each linked
 * to the file on GitHub at the release ref — a concrete "view the actual changes"
 * affordance alongside the source link. Renders nothing when no file data is
 * available (an entry citing only tickets, or PRs whose files weren't harvested).
 */
function ChangedFiles({ sources }: { sources: string[] }) {
  const [open, setOpen] = useState(false);
  const sourceIndex = useSourceIndex();

  // Union across the entry's sources, deduped by path (a PR and its commits often
  // report overlapping files).
  const byPath = new Map<string, string>();
  for (const id of sources) {
    for (const f of sourceIndex[id]?.files ?? []) {
      if (!byPath.has(f.path)) byPath.set(f.path, f.url);
    }
  }
  const files = [...byPath.entries()];
  if (files.length === 0) return null;

  return (
    <span className="inline-block align-middle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20 transition hover:bg-violet-100"
        title="Show the files this change touched"
      >
        <svg
          viewBox="0 0 16 16"
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
          aria-hidden
        >
          <path d="M6 4l4 4-4 4V4z" />
        </svg>
        {files.length} file{files.length === 1 ? "" : "s"} changed
      </button>

      {open ? (
        <span className="mt-1.5 flex flex-col gap-1 rounded-lg border border-gray-200 bg-gray-50 p-2">
          {files.map(([path, url]) => (
            <a
              key={path}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-mono text-[11px] text-indigo-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              title={path}
            >
              {path}
            </a>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export function ChangelogList({
  entries,
  editing,
  onEditText,
}: {
  entries: ChangelogEntry[];
  editing: boolean;
  /** Update the text of the entry at `index` in the dashboard's draft state. */
  onEditText: (index: number, text: string) => void;
}) {
  const groups = groupByCategory(entries);

  return (
    <Panel
      title="Changelog"
      subtitle="Grouped by category. Expand any entry's chip to inspect the source evidence."
    >
      <div className="space-y-6">
        {groups.map(({ category, items }) => (
          <div key={category}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {category}
            </h3>
            <ul className="space-y-3">
              {items.map(({ entry, index }) => (
                <li
                  key={index}
                  className="rounded-lg border border-gray-100 bg-gray-50/50 p-3"
                >
                  {editing ? (
                    <textarea
                      value={entry.text}
                      onChange={(e) => onEditText(index, e.target.value)}
                      rows={2}
                      className="w-full resize-y rounded-md border border-indigo-200 bg-white p-2 text-sm text-gray-800 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      aria-label={`Edit changelog entry in ${category}`}
                    />
                  ) : (
                    <p className="text-sm leading-relaxed text-gray-800">
                      {entry.text}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    <SourceEvidence sources={entry.sources} />
                    <ChangedFiles sources={entry.sources} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}
