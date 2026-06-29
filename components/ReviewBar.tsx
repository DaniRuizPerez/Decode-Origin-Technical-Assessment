"use client";

/**
 * Sticky review bar — the approve/export control surface.
 *
 * WHY sticky at the top: review is the primary action, so the Edit toggle and
 * Approve/Export button stay reachable while scrolling long artifacts.
 *
 * WHY export happens here from the *current draft*: "Approve" should export
 * exactly what the reviewer sees after editing, in the spec's snake_case shape
 * (`toSpecOutput`). We build the JSON entirely client-side and trigger a
 * download via an object URL — no network, honoring the offline-first rule.
 */

import { useState } from "react";
import type { ReleaseArtifacts, ReleaseRef } from "@/lib/schemas";
import { toSpecOutput } from "@/lib/export";

/** Build a safe, descriptive filename from the release ref. */
function exportFilename(release: ReleaseRef): string {
  const slug = `${release.project}-${release.name ?? release.headRef}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `release-notes-${slug}.json`;
}

export function ReviewBar({
  release,
  artifacts,
  editing,
  onToggleEdit,
  dirty,
}: {
  release: ReleaseRef;
  /** The current (possibly edited) artifacts to export. */
  artifacts: ReleaseArtifacts;
  editing: boolean;
  onToggleEdit: () => void;
  /** True once the reviewer has changed any field — surfaced as a hint. */
  dirty: boolean;
}) {
  // Local-only approval state. WHY local: there is no persistence layer yet; the
  // coordinator can lift this to the server when /api/generate lands in Wave 3.
  const [approvedAt, setApprovedAt] = useState<string | null>(null);

  function handleApproveAndExport() {
    const spec = toSpecOutput(artifacts);
    const blob = new Blob([JSON.stringify(spec, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    // Programmatic anchor click is the standard way to trigger a file download
    // without a server round-trip.
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(release);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setApprovedAt(new Date().toISOString());
  }

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-2 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          {approvedAt ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 font-medium text-emerald-800">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path
                  fillRule="evenodd"
                  d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
                  clipRule="evenodd"
                />
              </svg>
              Approved &amp; exported
            </span>
          ) : (
            <span className="text-gray-500">
              Review the generated documentation, edit if needed, then approve.
            </span>
          )}
          {dirty && !approvedAt ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              edited
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleEdit}
            aria-pressed={editing}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              editing
                ? "bg-indigo-600 text-white hover:bg-indigo-700"
                : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            {editing ? "Done editing" : "Edit"}
          </button>
          <button
            type="button"
            onClick={handleApproveAndExport}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
          >
            Approve &amp; export JSON
          </button>
        </div>
      </div>
    </div>
  );
}
