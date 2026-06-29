/**
 * Barrel for the four pipeline agents, in execution order:
 *   Digester → Planner → Release Writer → Documentation Reviewer.
 *
 * Each is a pure async function over the shared contract types; the orchestration
 * that chains them lives in `lib/pipeline.ts`. The `buildDeterministic*` helpers
 * are the extractive baselines (also useful in tests).
 */

export { digest, buildDeterministicChangeSet } from "./digester";
export { plan, buildDeterministicPlan } from "./planner";
export { write } from "./writer";
export { reviewDocs } from "./docReviewer";
