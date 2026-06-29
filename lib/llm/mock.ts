/**
 * MockProvider — the offline, deterministic provider.
 *
 * This is the default the whole app runs with when no `ANTHROPIC_API_KEY` is set,
 * so the entire pipeline (and its test suite) works with no network and no key.
 *
 * Its contract is deliberately narrow: each agent computes a *grounded extractive
 * baseline* (`req.fallback`) — an answer assembled directly from the source
 * artifacts, so it carries real citations and never hallucinates — and the
 * MockProvider simply returns that baseline, re-validated against `req.schema`.
 * It does NOT invent content. That gives three properties the system relies on:
 *
 *   1. **Determinism** — same request in, deeply-equal value out. Tests and evals
 *      get a stable, reproducible pipeline without mocking the network.
 *   2. **Schema enforcement on the same path as the real provider** — we re-parse
 *      the fallback through `req.schema`, so the mock exercises the exact
 *      validation step `AnthropicProvider` does. A fallback that drifts from the
 *      schema fails here, loudly, rather than only against a live key.
 *   3. **Honest grounding** — because the value is the extractive baseline, every
 *      claim is already traceable to evidence; swapping in the real LLM only adds
 *      abstraction on top of the same grounded inputs.
 */

import type {
  AgentCallTrace,
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./provider";
import { summarize } from "./provider";

export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    // Re-validate the agent-supplied baseline against the output schema. This is
    // the same `schema.parse(...)` the real provider applies to model output, so
    // the mock catches a malformed baseline on the identical code path — and it
    // returns the schema's *parsed* value (defaults applied, unknown keys
    // stripped) so callers can't depend on the mock passing the input through
    // untouched.
    const value = req.schema.parse(req.fallback);

    // A minimal, honest trace. ms = 0 because no work was done beyond validation;
    // tokens = null because no model was called (there is nothing to count). The
    // summaries identify the call without persisting the payloads.
    const trace: AgentCallTrace = {
      agent: req.agent,
      provider: this.name,
      ms: 0,
      inputSummary: summarize(req.prompt),
      // Summarise the JSON form of the value, not the prompt: the output summary
      // should reflect what this call produced.
      outputSummary: summarize(JSON.stringify(value)),
      tokens: null,
    };

    return { value, trace };
  }
}
