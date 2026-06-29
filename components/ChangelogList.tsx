"use client";

/**
 * Changelog, grouped by category, with per-entry source evidence.
 *
 * WHY client: in edit mode each entry's text becomes an editable <textarea>
 * bound to the dashboard's local draft state (see Dashboard). The grouping is
 * derived at render time so it always reflects the current entries — including
 * any the pipeline emits later — rather than a precomputed structure.
 */

import type { ChangelogEntry } from "@/lib/schemas";
import { SourceEvidence } from "./SourceEvidence";
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
                  <div className="mt-2">
                    <SourceEvidence sources={entry.sources} />
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
