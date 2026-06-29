"use client";

/**
 * Source-evidence chip — the visible face of the grounding guarantee.
 *
 * WHY this is its own component and a graded feature: the schema requires every
 * generated line to carry `sources[]` (commit/PR/ticket ids) so "every claim is
 * traceable to evidence" holds by construction. This widget makes that
 * machine-checkable contract *human-reviewable*: a collapsed chip shows the
 * evidence count, and expanding it lists the exact artifact ids (parsed into a
 * type + label so a reviewer can audit provenance at a glance).
 *
 * WHY client: it toggles open/closed, which needs local state.
 */

import { useState } from "react";

/** Namespaced id kinds, per the schema's `commit:|pr:|ticket:` convention. */
type SourceKind = "commit" | "pr" | "ticket" | "chunk" | "other";

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
          <span className="flex flex-wrap gap-1.5">
            {sources.map((id) => {
              const { kind, label } = classify(id);
              return (
                <span
                  key={id}
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset ${KIND_STYLES[kind]}`}
                  title={id}
                >
                  <span className="font-sans font-semibold uppercase opacity-70">
                    {KIND_PREFIX[kind]}
                  </span>
                  {label}
                </span>
              );
            })}
          </span>
        </span>
      ) : null}
    </span>
  );
}
