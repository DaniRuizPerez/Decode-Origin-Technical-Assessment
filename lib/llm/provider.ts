/**
 * Local ergonomics for the LLM provider layer.
 *
 * The provider *contract* (`CompletionRequest`, `CompletionResult`,
 * `LLMProvider`, `AgentCallTrace`) is defined once in `@/lib/schemas` so every
 * consumer — the agents and the grounding loop — depends on the same boundary
 * type. We re-export those here so files inside `lib/llm` can import the contract
 * from a sibling (`./provider`) instead of reaching across the tree, and so this
 * module is the single place that also exposes the small shared helpers the two
 * concrete providers need.
 */

import type {
  AgentCallTrace,
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "@/lib/schemas";

// Re-export the contract verbatim. These are the only provider types callers
// should ever need; importing them from "@/lib/llm" keeps the public surface of
// this module self-contained.
export type {
  AgentCallTrace,
  CompletionRequest,
  CompletionResult,
  LLMProvider,
};

/**
 * Max characters kept in a trace's `inputSummary` / `outputSummary`.
 *
 * Traces power the UI "pipeline trace" view and are persisted with every run, so
 * they must stay small and bounded — we never want a multi-KB prompt or a large
 * generated artifact living in the trace. 240 chars is enough to recognise *which*
 * call this was without storing the payload.
 */
const SUMMARY_MAX = 240;

/**
 * Collapse arbitrary text into a single-line, length-bounded trace summary.
 *
 * WHY normalise whitespace: prompts and JSON outputs are multi-line; a trace
 * summary is rendered inline in a table, so newlines/tabs/runs of spaces become a
 * single space. WHY a hard truncation with an ellipsis: bounding the length keeps
 * the persisted trace cheap and the UI predictable; the ellipsis signals that the
 * content was clipped rather than that the call produced little output.
 */
export function summarize(text: string, max: number = SUMMARY_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  // Reserve one char for the ellipsis so the result is exactly `max` long.
  return collapsed.slice(0, max - 1) + "…";
}
