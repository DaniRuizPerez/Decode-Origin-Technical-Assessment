/**
 * Public API of the swappable LLM provider layer.
 *
 * Downstream code imports from `@/lib/llm` and calls `getProvider()` rather than
 * constructing a provider directly — that keeps the choice of AI backend a single
 * swap-point, mirroring the ingestion layer's `getConnector()`.
 *
 * Offline-first by default: with no API key configured, the app (and every test)
 * runs against the deterministic `MockProvider`. Setting `ANTHROPIC_API_KEY`
 * activates the real `AnthropicProvider` (Claude Opus 4.8) with no other change.
 */

import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import type { LLMProvider } from "./provider";

// Concrete providers and the shared trace helper, for callers that need them
// directly (e.g. tests, or an agent that wants to summarise its own trace text).
export { AnthropicProvider } from "./anthropic";
export { MockProvider } from "./mock";
export { summarize } from "./provider";

// The provider contract, re-exported so consumers get the whole boundary from one
// import site (`@/lib/llm`) without also importing `@/lib/schemas`.
export type {
  AgentCallTrace,
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./provider";

/**
 * The provider the app runs with.
 *
 * Key-activated, offline-by-default: returns the real `AnthropicProvider` when
 * `ANTHROPIC_API_KEY` is present and non-empty, otherwise the `MockProvider`.
 *
 * WHY the `.trim()` check: an env var set to an empty string is effectively
 * unset (and would make the SDK fail at call time with no key) — treat it as
 * "no key configured" and stay on the mock, so a misconfigured deployment
 * degrades to the deterministic baseline rather than erroring.
 *
 * Returns the narrow `LLMProvider` port on purpose, so callers can't couple to
 * provider-specific methods through this entry point.
 */
export function getProvider(): LLMProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return new AnthropicProvider();
  }
  return new MockProvider();
}
