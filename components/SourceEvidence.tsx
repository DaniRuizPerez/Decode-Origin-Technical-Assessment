"use client";

/**
 * Source-evidence chip — the visible face of the grounding guarantee.
 *
 * WHY this is its own component and a graded feature: the schema requires every
 * generated line to carry `sources[]` (commit/PR/ticket ids) so "every claim is
 * traceable to evidence" holds by construction. This widget makes that
 * machine-checkable contract *human-reviewable*: a collapsed chip shows the
 * evidence count, and expanding it lists each cited artifact.
 *
 * When the package carries a resolved `sourceIndex` (via {@link useSourceIndex}),
 * each id is enriched with a readable title and — for commits/PRs — a clickable
 * GitHub link, so a reviewer can read and open the evidence instead of decoding
 * raw ids. An id missing from the index (e.g. an empty `sourceIndex`) degrades
 * gracefully to the original id-only chip.
 *
 * WHY client: it toggles open/closed, which needs local state.
 */

import { useState } from "react";
import { useSourceIndex } from "./SourceIndexContext";

/** Namespaced id kinds, per the schema's `commit:|pr:|ticket:` convention. */
type SourceKind = "commit" | "pr" | "ticket" | "chunk" | "other";

/** Cap on the rendered title so a long PR/commit subject can't blow out the row. */
const TITLE_MAX = 70;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function classify(id: string): { kind: SourceKind; label: string } {
  // The contract guarantees stable namespaced ids; we parse the prefix to give
  // each evidence item a readable label and a distinct colour.
  if (id.startsWith("commit:")) return { kind: "commit", label: id.slice(7, 14) };
  if (id.startsWith("pr:")) return { kind: "pr", label: `#${id.slice(3)}` };
  if (id.startsWith("ticket:")) return { kind: "ticket", label: id.slice(7) };
  if (id.startsWith("chunk:")) return { kind: "chunk", label: id.slice(6) };
  return { kind: "other", label: id };
}

const KIND_STYLES: Record<SourceKind, string> = {
  commit: "bg-violet-50 text-violet-700 ring-violet-600/20",
  pr: "bg-sky-50 text-sky-700 ring-sky-600/20",
  ticket: "bg-teal-50 text-teal-700 ring-teal-600/20",
  chunk: "bg-gray-50 text-gray-600 ring-gray-500/20",
  other: "bg-gray-50 text-gray-600 ring-gray-500/20",
};

const KIND_PREFIX: Record<SourceKind, string> = {
  commit: "commit",
  pr: "PR",
  ticket: "ticket",
  chunk: "chunk",
  other: "src",
};

export function SourceEvidence({
  sources,
  /** Optional extra context shown above the id list when expanded. */
  note,
}: {
  sources: string[];
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  // Resolved citations (title + GitHub url) for the whole package. Empty when no
  // provider is mounted or the package predates sourceIndex — in which case each
  // chip degrades to the id-only form below.
  const sourceIndex = useSourceIndex();

  // WHY explicit empty state: an ungrounded line is a contract violation worth
  // surfacing loudly rather than silently omitting the chip.
  if (sources.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20">
        no sources
      </span>
    );
  }

  return (
    <span className="inline-block align-middle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20 transition hover:bg-indigo-100"
        title="Show source evidence"
      >
        <svg
          viewBox="0 0 16 16"
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
          aria-hidden
        >
          <path d="M6 4l4 4-4 4V4z" />
        </svg>
        {sources.length} source{sources.length === 1 ? "" : "s"}
      </button>

      {open ? (
        <span className="mt-1.5 flex flex-col gap-1.5 rounded-lg border border-gray-200 bg-gray-50 p-2">
          {note ? (
            <span className="text-[11px] leading-snug text-gray-500">{note}</span>
          ) : null}
          <span className="flex flex-col gap-1.5">
            {sources.map((id) => {
              const { kind, label } = classify(id);
              // Prefer the resolved ref (readable title + GitHub url). Falls back
              // to the id-only chip when the id isn't in the index.
              const ref = sourceIndex[id];
              const chip = (
                <span
                  className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset ${KIND_STYLES[kind]}`}
                  title={id}
                >
                  <span className="font-sans font-semibold uppercase opacity-70">
                    {KIND_PREFIX[kind]}
                  </span>
                  {label}
                </span>
              );

              if (!ref) {
                // Graceful degradation: today's id-only chip.
                return (
                  <span key={id} className="inline-flex">
                    {chip}
                  </span>
                );
              }

              return (
                <span key={id} className="flex items-center gap-1.5">
                  {chip}
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] leading-snug text-gray-700"
                    title={ref.title}
                  >
                    {truncate(ref.title, TITLE_MAX)}
                  </span>
                  {ref.url ? (
                    <a
                      href={ref.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex shrink-0 items-center gap-0.5 rounded text-[11px] font-medium text-indigo-600 underline-offset-2 transition hover:text-indigo-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      aria-label={`Open ${KIND_PREFIX[kind]} ${label} on GitHub (opens in a new tab)`}
                      title={ref.url}
                    >
                      GitHub
                      <svg
                        viewBox="0 0 16 16"
                        className="h-3 w-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 3.5H4.5A1.5 1.5 0 003 5v6.5A1.5 1.5 0 004.5 13H11a1.5 1.5 0 001.5-1.5V10M9.5 3.5H13m0 0V7m0-3.5L7 9.5"
                        />
                      </svg>
                    </a>
                  ) : null}
                </span>
              );
            })}
          </span>
        </span>
      ) : null}
    </span>
  );
}
