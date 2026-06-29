/**
 * AnthropicProvider — the real, abstractive provider (Claude Opus 4.8).
 *
 * Selected by `getProvider()` only when `ANTHROPIC_API_KEY` is set; it is NOT
 * exercised by the test suite (offline-first — no key, no network in tests), so
 * this file must be *correct by construction*: it compiles against the installed
 * `@anthropic-ai/sdk` (v0.107) types, and every call-shape decision below is made
 * to match the SDK + the Claude Opus 4.8 request surface.
 *
 * Design choices, and the WHY behind each:
 *
 *  - **Model `claude-opus-4-8`** — the assessment's target model.
 *  - **Adaptive thinking** (`thinking: { type: "adaptive" }`) — on Opus 4.7/4.8
 *    this is the only supported on-mode; the deprecated `budget_tokens` form
 *    returns a 400. We let Claude decide depth per request.
 *  - **No `temperature` / `top_p` / `budget_tokens`** — all three are *removed*
 *    on Opus 4.8 and return a 400 if sent. Determinism/format is steered by the
 *    structured-output schema instead, not by sampling params.
 *  - **Structured output via `output_config.format`** — we hand Claude the JSON
 *    schema (`type: "json_schema"`) derived from the agent's zod schema using
 *    zod v4's built-in `z.toJSONSchema(...)`. We then parse the returned text as
 *    JSON and validate it with `req.schema.parse(...)`. This is the SDK-stable,
 *    zod-v4-safe path (the SDK also ships a `zodOutputFormat()` helper, but the
 *    manual schema path avoids any coupling to that helper's zod-version support
 *    and keeps validation in our hands — the same `schema.parse` the mock uses).
 *  - **Prompt-cache the system prompt** — the system prompt is sent as a single
 *    text block carrying `cache_control: { type: "ephemeral" }`. System prompts
 *    are large and stable across a run's many agent calls, so caching the prefix
 *    is the cheap, high-leverage breakpoint. Volatile content (the per-call
 *    prompt) stays in the user turn, after the cached prefix, so it never
 *    invalidates the cache.
 *  - **Trace tokens from `response.usage`** — `input_tokens` / `output_tokens`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type {
  AgentCallTrace,
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./provider";
import { summarize } from "./provider";

/** Opus 4.8 — see file header for why this exact id and request surface. */
const MODEL = "claude-opus-4-8";

/**
 * Output cap. Generous enough for the largest artifact (full release notes /
 * doc-update sets) without risking truncation; well under the streaming
 * threshold, so a non-streaming `messages.create` won't hit the SDK's HTTP
 * timeout guard.
 */
const MAX_TOKENS = 16_000;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";

  private readonly client: Anthropic;

  /**
   * The SDK reads `ANTHROPIC_API_KEY` from the environment by default; we accept
   * an optional override only to keep the class testable/injectable. We do NOT
   * hardcode or log the key.
   */
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    // zod v4 → JSON Schema (draft 2020-12, `additionalProperties: false`), the
    // shape `output_config.format` expects for structured outputs.
    const jsonSchema = z.toJSONSchema(req.schema);

    const start = Date.now();
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Adaptive thinking: Claude decides when/how much to reason. No
      // temperature/top_p/budget_tokens (removed on Opus 4.8).
      thinking: { type: "adaptive" },
      // Structured output: constrain the response to the agent's schema.
      output_config: {
        format: {
          type: "json_schema",
          // JSON Schema is an open record; the SDK types `schema` as
          // `{ [k: string]: unknown }`, which `z.toJSONSchema` satisfies.
          schema: jsonSchema as Record<string, unknown>,
        },
      },
      // System prompt as a single cached text block. The ephemeral breakpoint
      // caches this (stable) prefix across the run's many calls; the volatile
      // per-call prompt lives in the user turn below, so it never busts the cache.
      system: [
        {
          type: "text",
          text: req.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: req.prompt }],
    });
    const ms = Date.now() - start;

    // With `output_config.format`, the response is a single text block of valid
    // JSON. Concatenate any text blocks (defensive — normally exactly one) and
    // ignore non-text blocks such as thinking.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse the model's JSON and validate against the agent's schema — the same
    // `schema.parse(...)` the MockProvider applies, so both providers return a
    // value that has passed identical validation. A schema violation throws here.
    const value = req.schema.parse(JSON.parse(text));

    const trace: AgentCallTrace = {
      agent: req.agent,
      provider: this.name,
      ms,
      inputSummary: summarize(req.prompt),
      outputSummary: summarize(text),
      tokens: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };

    return { value, trace };
  }
}
