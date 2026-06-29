"use client";

/**
 * Collapsible pipeline-trace view — the observability surface.
 *
 * WHY: each `AgentCallTrace` records one stage's provider, latency, in/out
 * summaries, and token usage. Showing them gives a reviewer confidence in *how*
 * the artifacts were produced (and which provider — "mock" vs "anthropic" — ran
 * each stage). Collapsed by default because it is secondary to the artifacts;
 * client component because it toggles open.
 */

import { useState } from "react";
import type { AgentCallTrace } from "@/lib/schemas";

export function PipelineTrace({ trace }: { trace: AgentCallTrace[] }) {
  const [open, setOpen] = useState(false);

  const totalMs = trace.reduce((s, t) => s + t.ms, 0);

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
      >
        <span className="flex items-center gap-2">
          <svg
            viewBox="0 0 16 16"
            className={`h-4 w-4 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
            fill="currentColor"
            aria-hidden
          >
            <path d="M6 4l4 4-4 4V4z" />
          </svg>
          <span className="text-base font-semibold text-gray-900">
            Pipeline trace
          </span>
        </span>
        <span className="text-sm text-gray-500">
          {trace.length} stage{trace.length === 1 ? "" : "s"} · {totalMs} ms
        </span>
      </button>

      {open ? (
        <div className="border-t border-gray-100 p-5 pt-4">
          <ol className="space-y-3">
            {trace.map((t, i) => (
              <li key={i} className="relative pl-5">
                {/* timeline dot */}
                <span
                  className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-indigo-400"
                  aria-hidden
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-gray-900">
                    {t.agent}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      t.provider === "mock"
                        ? "bg-gray-100 text-gray-600"
                        : "bg-indigo-100 text-indigo-700"
                    }`}
                  >
                    {t.provider}
                  </span>
                  <span className="text-xs tabular-nums text-gray-400">
                    {t.ms} ms
                  </span>
                  {t.tokens ? (
                    <span className="text-xs tabular-nums text-gray-400">
                      · {t.tokens.input}→{t.tokens.output} tok
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[13px] text-gray-500">
                  <span className="text-gray-400">in:</span> {t.inputSummary}
                </p>
                <p className="text-[13px] text-gray-500">
                  <span className="text-gray-400">out:</span> {t.outputSummary}
                </p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
