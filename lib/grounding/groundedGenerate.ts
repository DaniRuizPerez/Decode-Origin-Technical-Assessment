/**
 * Grounded generation wrapper — the in-loop faithfulness controller.
 *
 * WHY this exists: measuring hallucination *after* a run is too late. The spec's
 * grounding guarantee is enforced "in the loop" — every generated artifact is
 * verified against the real evidence the moment it's produced, and an
 * unfaithful first draft gets one bounded chance to repair itself before we
 * accept it. This wrapper is that controller: it sits between an agent and its
 * `LLMProvider` and turns "generate" into "generate → verify → (repair once)".
 *
 * It is deliberately generic over the artifact type `T`: the writer emits
 * release notes, the changelog stage emits entries, the doc reviewer emits
 * update suggestions — all carry per-item `sources[]`, so one wrapper grounds
 * them all. The caller supplies `extractItems` to project whatever `T` is down
 * to the `{ sources }[]` the verifier understands.
 *
 * Offline behavior: with the MockProvider (which returns the agent's
 * deterministic grounded `fallback`), the first draft is already faithful, so
 * the loop verifies once, finds nothing flagged, and returns — a clean no-op
 * pass with a single trace and zero repair calls. The repair path only fires
 * against a provider that can actually emit a bad citation (the Anthropic
 * provider, or a test stub), which is exactly where the guard earns its keep.
 */

import type {
  AgentCallTrace,
  CompletionRequest,
  LLMProvider,
} from "@/lib/schemas";

import { verifyItems, type FaithfulnessReport } from "./verify";

/** Inputs to one grounded generation. */
export interface GroundedGenerateOptions<T> {
  /** The swappable AI boundary (MockProvider offline, AnthropicProvider live). */
  provider: LLMProvider;
  /** The structured-generation request, including its grounded `fallback`. */
  request: CompletionRequest<T>;
  /**
   * Projects the generated value down to the citation-bearing items the verifier
   * checks. Supplied by the caller because only it knows the shape of `T` (e.g.
   * "flatten changelog + both note arrays + doc updates into one item list").
   */
  extractItems: (value: T) => { sources: string[] }[];
  /** The set of source ids that actually exist in the release window. */
  validSourceIds: Set<string>;
  /**
   * Max repair attempts after the initial generation. Default 1: a single
   * bounded retry is the spec's contract. Bounding it matters because repair
   * costs another LLM call and may not converge — we prefer to *surface* a
   * residual faithfulness failure in the report over looping indefinitely.
   */
  maxRepairs?: number;
}

/** Output of a grounded generation: the accepted value, its faithfulness report, and every call's trace. */
export interface GroundedGenerateResult<T> {
  value: T;
  report: FaithfulnessReport;
  /** One trace per provider call (initial + any repairs), in call order. */
  traces: AgentCallTrace[];
}

/**
 * Build the repair instruction appended to the prompt on a retry.
 *
 * It names the offending items by index and states each concrete issue, then
 * gives the model two acceptable remedies: re-cite using only real ids, or drop
 * the unsupported claim. WHY name specifics: a generic "fix your citations"
 * tends to produce the same hallucination again; pointing at "item 2 cites
 * unknown source id(s): pr:9999" gives the model the exact correction target.
 */
function buildRepairInstruction(report: FaithfulnessReport): string {
  const lines = report.flagged.map((f) => `- item ${f.index}: ${f.issue}`);
  return [
    "",
    "GROUNDING REPAIR REQUIRED.",
    "These items cited unknown or empty sources:",
    ...lines,
    "Regenerate citing ONLY ids from the provided evidence, or drop the unsupported claims.",
  ].join("\n");
}

/**
 * Generate a structured artifact and enforce citation faithfulness in the loop.
 *
 * Flow:
 *  1. Call `provider.complete(request)` → first draft `value` (+ trace).
 *  2. `verifyItems(extractItems(value), validSourceIds)` → report.
 *  3. While the report has flagged items AND repairs remain: append a repair
 *     instruction to the prompt, call the provider again, re-verify, accumulate
 *     the trace. Each iteration consumes one of `maxRepairs`.
 *  4. Return the final accepted value, its (final) report, and all traces.
 *
 * Note we keep whatever the last attempt produced even if it's still flagged:
 * the bounded loop guarantees termination, and a residual failure is reported
 * (in `report.flagged`) rather than thrown, so the caller/UI can show it as an
 * incomplete-information signal instead of crashing the pipeline.
 */
export async function groundedGenerate<T>(
  opts: GroundedGenerateOptions<T>,
): Promise<GroundedGenerateResult<T>> {
  const { provider, request, extractItems, validSourceIds } = opts;
  const maxRepairs = opts.maxRepairs ?? 1;

  const traces: AgentCallTrace[] = [];

  // --- Initial generation ---------------------------------------------------
  const first = await provider.complete(request);
  traces.push(first.trace);

  let value = first.value;
  let report = verifyItems(extractItems(value), validSourceIds);

  // --- Bounded repair loop --------------------------------------------------
  // `repairsLeft` is a plain countdown so the loop provably terminates: each
  // iteration makes exactly one provider call and decrements it, regardless of
  // whether that call actually fixed anything.
  let repairsLeft = maxRepairs;
  while (report.flagged.length > 0 && repairsLeft > 0) {
    repairsLeft -= 1;

    // Re-issue the SAME request with the repair instruction appended to the
    // prompt. We clone rather than mutate `request` so the caller's object is
    // never altered (it may be reused) and each attempt is self-contained.
    const repairRequest: CompletionRequest<T> = {
      ...request,
      prompt: request.prompt + buildRepairInstruction(report),
    };

    const repaired = await provider.complete(repairRequest);
    traces.push(repaired.trace);

    value = repaired.value;
    report = verifyItems(extractItems(value), validSourceIds);
  }

  return { value, report, traces };
}
