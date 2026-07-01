"use client";

/**
 * Sticky review bar — the approve/export control surface.
 *
 * WHY sticky at the top: review is the primary action, so the Edit toggle and
 * Approve/Export button stay reachable while scrolling long artifacts.
 *
 * WHY approve goes through the server: "Approve" should ship exactly what the
 * reviewer sees after editing, but the export must be the *server-validated*
 * artifact. We POST the current draft package to `/api/approve`, which
 * re-validates it against the contract and stamps the approval; on success we
 * download the snake_case `specOutput` the server returns. If the server is
 * unreachable (offline / 5xx) we fall back to building the same export
 * client-side via `toSpecOutput`, honoring the offline-first rule. A 422 means
 * the (edited) package is invalid — we surface the schema issues inline and let
 * the reviewer fix and retry rather than exporting a broken artifact.
 */

import { useState } from "react";
import type { ReleasePackage, ReleaseRef } from "@/lib/schemas";
import { toSpecOutput, type SpecOutput } from "@/lib/export";

/** Build a safe, descriptive filename from the release ref. */
function exportFilename(release: ReleaseRef): string {
  const slug = `${release.project}-${release.name ?? release.headRef}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `release-notes-${slug}.json`;
}

/** Trigger a browser download of `spec` as pretty-printed JSON. */
function downloadSpec(spec: SpecOutput, filename: string) {
  const blob = new Blob([JSON.stringify(spec, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  // Programmatic anchor click is the standard way to trigger a file download.
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ReviewBar({
  pkg,
  editing,
  onToggleEdit,
  dirty,
}: {
  /** The current (possibly edited) draft package to approve + export. */
  pkg: ReleasePackage;
  editing: boolean;
  onToggleEdit: () => void;
  /** True once the reviewer has changed any field — surfaced as a hint. */
  dirty: boolean;
}) {
  // Local-only approval state. WHY local: the server stamps `approval` on the
  // returned package, but there is no persistence layer yet, so the UI keeps
  // the approved timestamp in component state for the current session.
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  // Schema issues from a 422 response, surfaced inline. `null` = no error.
  const [issues, setIssues] = useState<string[] | null>(null);
  // Disable the button while the approve request is in flight.
  const [submitting, setSubmitting] = useState(false);
  // Transient "download happened" confirmation, shown briefly after a successful
  // export (either the server-validated 200 path or the offline fallback).
  const [exported, setExported] = useState(false);

  const filename = exportFilename(pkg.release);

  async function handleApproveAndExport() {
    setSubmitting(true);
    setIssues(null);
    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pkg),
      });

      if (res.status === 422) {
        // The edited package is invalid. Surface the schema issues inline and
        // do NOT export — let the reviewer fix the offending field and retry.
        const data = (await res.json().catch(() => null)) as
          | { issues?: Array<{ path?: Array<string | number>; message?: string }> }
          | null;
        const messages =
          data?.issues?.map((i) => {
            const path = (i.path ?? []).join(".");
            return path ? `${path}: ${i.message ?? "invalid"}` : (i.message ?? "invalid");
          }) ?? [];
        setIssues(messages.length > 0 ? messages : ["Package failed validation."]);
        return;
      }

      if (!res.ok) {
        // 5xx / unexpected status: fall through to the offline fallback below.
        throw new Error(`approve failed with status ${res.status}`);
      }

      // 200: download the SERVER-validated export, then mark approved.
      const data = (await res.json()) as { specOutput: SpecOutput };
      downloadSpec(data.specOutput, filename);
      setApprovedAt(new Date().toISOString());
      setExported(true);
      setTimeout(() => setExported(false), 4000);
    } catch {
      // Network error or non-2xx/non-422 response: fall back to building the
      // export client-side so approve still works offline.
      downloadSpec(toSpecOutput(pkg.artifacts), filename);
      setApprovedAt(new Date().toISOString());
      setExported(true);
      setTimeout(() => setExported(false), 4000);
    } finally {
      setSubmitting(false);
    }
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
          {exported ? (
            <span className="text-xs font-medium text-emerald-700">
              ✓ Export downloaded
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleApproveAndExport}
            disabled={submitting}
            aria-busy={submitting}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <span className="inline-flex items-center gap-1.5">
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"
                  />
                </svg>
                Approving…
              </span>
            ) : (
              "Approve & export JSON"
            )}
          </button>
        </div>
      </div>

      <nav className="mt-2 flex gap-3 border-t border-gray-100 pt-2 text-xs text-gray-500">
        <a href="#changelog" className="hover:text-indigo-600">
          Changelog
        </a>
        <a href="#notes" className="hover:text-indigo-600">
          Notes
        </a>
        <a href="#docs" className="hover:text-indigo-600">
          Doc updates
        </a>
      </nav>

      {issues ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          <p className="font-semibold">Can&apos;t approve — the package failed validation:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {issues.map((msg, i) => (
              <li key={i} className="font-mono text-xs">
                {msg}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-rose-700">
            Fix the highlighted fields and approve again.
          </p>
        </div>
      ) : null}
    </div>
  );
}
