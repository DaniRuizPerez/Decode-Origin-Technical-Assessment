"use client";

/**
 * Documentation update suggestions: doc path → section → suggestion, each with
 * its grounding and a "possible doc debt" flag.
 *
 * WHY surface the retrieved chunk: a doc suggestion is only trustworthy if it
 * points at real existing copy. We resolve `retrievedChunkId` against the
 * package's `retrieval[]` and let the reviewer expand the actual chunk text — so
 * the suggestion is grounded in retrieval evidence, not just asserted.
 *
 * WHY the doc-debt badge matters: `isPossibleDocDebt` means we recommend
 * updating a doc the release did NOT touch. That is a *suggestion*, not an error
 * (changed-docs is a noisy proxy), so it gets a distinct amber badge rather than
 * being hidden or treated as a defect.
 */

import { useState } from "react";
import type { DocUpdate, RetrievedChunk } from "@/lib/schemas";
import { SourceEvidence } from "./SourceEvidence";
import { Panel, DocDebtBadge, CodeChip } from "./ui";

/** Expandable view of the retrieved chunk that grounds a suggestion. */
function RetrievalEvidence({ chunk }: { chunk: RetrievedChunk }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-gray-700"
      >
        <svg
          viewBox="0 0 16 16"
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
          aria-hidden
        >
          <path d="M6 4l4 4-4 4V4z" />
        </svg>
        retrieved evidence · score {chunk.score.toFixed(2)}
      </button>
      {open ? (
        <blockquote className="mt-1.5 rounded-md border-l-2 border-gray-300 bg-gray-50 p-2 text-[13px] italic leading-snug text-gray-600">
          {chunk.text}
          <footer className="mt-1 flex flex-wrap gap-2 not-italic text-[11px] text-gray-400">
            {chunk.signals.bm25 != null ? (
              <span>bm25 {chunk.signals.bm25.toFixed(2)}</span>
            ) : null}
            {chunk.signals.dense != null ? (
              <span>dense {chunk.signals.dense.toFixed(2)}</span>
            ) : null}
          </footer>
        </blockquote>
      ) : null}
    </div>
  );
}

export function DocumentationUpdates({
  updates,
  retrieval,
  editing,
  onEditSuggestion,
}: {
  updates: DocUpdate[];
  retrieval: RetrievedChunk[];
  editing: boolean;
  onEditSuggestion: (index: number, suggestion: string) => void;
}) {
  // Index retrieval by id once so each suggestion can resolve its chunk in O(1).
  const chunkById = new Map(retrieval.map((c) => [c.id, c]));

  return (
    <Panel
      title="Documentation updates"
      subtitle="Suggested edits to existing docs, grounded in retrieved sections."
    >
      <ul className="space-y-4">
        {updates.map((u, index) => {
          const chunk = u.retrievedChunkId
            ? chunkById.get(u.retrievedChunkId)
            : undefined;
          return (
            <li
              key={index}
              className="rounded-lg border border-gray-100 bg-gray-50/50 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CodeChip>{u.docPath}</CodeChip>
                  <span className="text-gray-400" aria-hidden>
                    ›
                  </span>
                  <span className="text-sm font-medium text-gray-700">
                    {u.section}
                  </span>
                </div>
                {u.isPossibleDocDebt ? <DocDebtBadge /> : null}
              </div>

              {editing ? (
                <textarea
                  value={u.suggestion}
                  onChange={(e) => onEditSuggestion(index, e.target.value)}
                  rows={2}
                  className="mt-2 w-full resize-y rounded-md border border-indigo-200 bg-white p-2 text-sm text-gray-800 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  aria-label={`Edit suggestion for ${u.docPath}`}
                />
              ) : (
                <p className="mt-2 text-sm leading-relaxed text-gray-700">
                  {u.suggestion}
                </p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <SourceEvidence sources={u.sources} />
              </div>
              {chunk ? <RetrievalEvidence chunk={chunk} /> : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
