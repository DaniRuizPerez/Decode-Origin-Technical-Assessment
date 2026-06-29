/**
 * Public API of the grounding / faithfulness loop.
 *
 * Two layers, one barrel:
 *  - `verify`  — the deterministic reference verifier (offline, zero-token):
 *    does every cited id exist? Produces a `FaithfulnessReport`.
 *  - `groundedGenerate` — the in-loop controller that wraps any `LLMProvider`
 *    call in generate → verify → bounded-repair, so unfaithful drafts get one
 *    chance to self-correct before being accepted.
 *
 * Consumers (the writer / changelog / doc-reviewer agents) import from
 * `@/lib/grounding` and never reach into the individual modules — keeping the
 * verifier swappable (a semantic LLM-backed verifier is a documented future
 * extension that would reuse the same `FaithfulnessReport` shape).
 */

export {
  verifyReferences,
  verifyItems,
  type ReferenceCheck,
  type FlaggedItem,
  type FaithfulnessReport,
} from "./verify";

export {
  groundedGenerate,
  type GroundedGenerateOptions,
  type GroundedGenerateResult,
} from "./groundedGenerate";
