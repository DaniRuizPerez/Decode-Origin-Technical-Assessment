import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AnthropicProvider,
  MockProvider,
  getProvider,
  summarize,
  type CompletionRequest,
} from "./index";
import { ChangeSetSchema, type ChangeSet } from "@/lib/schemas";

/**
 * The whole point of this layer is that it works offline: these tests run with
 * NO network and NO API key. They cover the guarantees the system leans on —
 * mock determinism, schema validation on the same path as the real provider,
 * key-gated `getProvider()` selection, and — via a FAKE injected SDK client —
 * the AnthropicProvider's own parse/trace behavior, all without ever touching
 * the network.
 *
 * `AnthropicProvider.complete()` is exercised here only through its injectable
 * `constructor(client?)`: we hand it a hand-rolled object shaped like the SDK's
 * `{ messages: { create } }` and cast it to `Anthropic`, so `create()` returns a
 * canned response and NO HTTP request is ever made. `getProvider()` selection is
 * still asserted to pick the real provider when a key is present (construction
 * only — its `complete()` is never invoked through that path).
 */

describe("MockProvider", () => {
  const provider = new MockProvider();

  it('has the contract name "mock"', () => {
    expect(provider.name).toBe("mock");
  });

  it("returns the grounded fallback, re-validated against the schema", async () => {
    const fallback: ChangeSet = {
      changes: [
        {
          id: "chg:1",
          type: "feature",
          summary: "Add adaptive thinking support",
          details: "",
          components: ["llm"],
          sourceIds: ["pr:42"],
          confidence: 1,
          isBreaking: false,
        },
      ],
      unlinkedArtifactIds: [],
    };

    const req: CompletionRequest<ChangeSet> = {
      agent: "digester",
      system: "You are the digester.",
      prompt: "Normalize these changes.",
      schema: ChangeSetSchema,
      fallback,
    };

    const { value } = await provider.complete(req);
    // The extractive baseline is returned faithfully (deep-equal after parse).
    expect(value).toEqual(fallback);
  });

  it("is deterministic: same input → deeply-equal output", async () => {
    const req: CompletionRequest<ChangeSet> = {
      agent: "digester",
      system: "sys",
      prompt: "prompt",
      schema: ChangeSetSchema,
      fallback: { changes: [], unlinkedArtifactIds: [] },
    };

    const a = await provider.complete(req);
    const b = await provider.complete(req);
    expect(a.value).toEqual(b.value);
    // Trace is deterministic too (ms is fixed at 0, no timestamps/tokens).
    expect(a.trace).toEqual(b.trace);
  });

  it("applies schema parsing (defaults filled, unknown keys stripped)", async () => {
    // A minimal change schema with a default + strict object, to prove the mock
    // returns the *parsed* value rather than the raw fallback object.
    const schema = z.object({
      label: z.string(),
      weight: z.number().default(5),
    });
    type Out = z.infer<typeof schema>;

    // Cast through the input shape: callers pass a value the schema accepts; the
    // mock re-parses it, so defaults are applied on the way out.
    const fallback = { label: "x", extra: "dropped" } as unknown as Out;

    const { value } = await new MockProvider().complete({
      agent: "t",
      system: "s",
      prompt: "p",
      schema,
      fallback,
    });

    expect(value).toEqual({ label: "x", weight: 5 });
    expect(value).not.toHaveProperty("extra");
  });

  it("throws when the fallback violates the schema", async () => {
    const schema = z.object({ n: z.number() });
    await expect(
      new MockProvider().complete({
        agent: "t",
        system: "s",
        prompt: "p",
        schema,
        // Wrong type — must fail on the same parse path the real provider uses.
        fallback: { n: "not-a-number" } as unknown as { n: number },
      }),
    ).rejects.toThrow();
  });

  it("records a mock trace (provider, ms 0, summaries, null tokens)", async () => {
    const { trace } = await new MockProvider().complete({
      agent: "writer",
      system: "s",
      prompt: "Write the customer release notes for v1.2.3.",
      schema: z.object({ ok: z.boolean() }),
      fallback: { ok: true },
    });

    expect(trace.agent).toBe("writer");
    expect(trace.provider).toBe("mock");
    expect(trace.ms).toBe(0);
    expect(trace.tokens).toBeNull();
    expect(trace.inputSummary).toContain("Write the customer release notes");
    expect(trace.outputSummary).toContain("ok");
  });
});

describe("AnthropicProvider (fake injected SDK client — no network)", () => {
  /**
   * A small request schema standing in for a real agent's structured output. Kept
   * tiny so the canned model "response" is easy to read; it still exercises the
   * exact code path the real agents use (schema.parse over JSON.parse(text)).
   */
  const ReplySchema = z.object({
    summary: z.string(),
    items: z.array(z.string()),
  });
  type Reply = z.infer<typeof ReplySchema>;

  function makeRequest(): CompletionRequest<Reply> {
    return {
      agent: "writer",
      system: "You write grounded release notes.",
      prompt: "Summarize the release for v1.2.3.",
      schema: ReplySchema,
      // The real provider ignores `fallback` (it generates abstractively); it is
      // present only to satisfy the contract.
      fallback: { summary: "", items: [] },
    };
  }

  /**
   * Build a fake Anthropic client whose `messages.create()` resolves to a canned
   * response. Shaped like the SDK surface the provider actually reads
   * (`content[]` text blocks + `usage`) and cast to `Anthropic` so NO real client
   * (and therefore no HTTP / no key) is ever constructed. `create` is also a spy
   * so a test can assert the provider issued exactly one call.
   */
  function fakeClient(response: unknown): {
    client: Anthropic;
    calls: () => number;
  } {
    let count = 0;
    const client = {
      messages: {
        create: async () => {
          count += 1;
          return response;
        },
      },
    } as unknown as Anthropic;
    return { client, calls: () => count };
  }

  it("HAPPY PATH: parses the model's JSON text block and returns value + trace", async () => {
    const value: Reply = {
      summary: "Adds adaptive thinking and streaming.",
      items: ["adaptive thinking", "streaming responses"],
    };
    // The model returns a single text block of schema-valid JSON, plus usage.
    const response = {
      content: [{ type: "text", text: JSON.stringify(value) }],
      usage: { input_tokens: 123, output_tokens: 45 },
    };
    const { client, calls } = fakeClient(response);

    const provider = new AnthropicProvider(client);
    const { value: out, trace } = await provider.complete(makeRequest());

    // Exactly one create() call — no retries, no extra network round-trips.
    expect(calls()).toBe(1);

    // The returned value is the parsed model output (valid against the schema).
    expect(out).toEqual(value);
    expect(() => ReplySchema.parse(out)).not.toThrow();

    // The trace carries the agent name, a numeric ms, and the SDK's token counts.
    expect(trace.agent).toBe("writer");
    expect(trace.provider).toBe("anthropic");
    expect(typeof trace.ms).toBe("number");
    expect(trace.ms).toBeGreaterThanOrEqual(0);
    expect(trace.tokens).toEqual({ input: 123, output: 45 });
    // Summaries are derived from the prompt / model text.
    expect(trace.inputSummary).toContain("Summarize the release");
    expect(trace.outputSummary).toContain("adaptive thinking");
  });

  it("concatenates multiple text blocks and ignores non-text (thinking) blocks", async () => {
    // Adaptive thinking can emit a thinking block before the answer; the provider
    // must filter to text blocks and join them into one JSON string.
    const value: Reply = { summary: "ok", items: ["a"] };
    const json = JSON.stringify(value);
    const response = {
      content: [
        { type: "thinking", thinking: "deliberating…" },
        { type: "text", text: json.slice(0, 10) },
        { type: "text", text: json.slice(10) },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    };
    const { client } = fakeClient(response);

    const { value: out } = await new AnthropicProvider(client).complete(
      makeRequest(),
    );
    expect(out).toEqual(value);
  });

  it("MALFORMED PATH: throws when the model text is not valid JSON", async () => {
    const response = {
      content: [{ type: "text", text: "this is not json {" }],
      usage: { input_tokens: 5, output_tokens: 1 },
    };
    const { client } = fakeClient(response);

    // JSON.parse blows up inside complete(); a bad model output must not propagate
    // as a (mistyped) value to callers.
    await expect(
      new AnthropicProvider(client).complete(makeRequest()),
    ).rejects.toThrow();
  });

  it("MALFORMED PATH: throws when the model JSON violates the request schema", async () => {
    // Well-formed JSON, wrong shape (items must be string[]). schema.parse must
    // reject it on the same path the MockProvider uses.
    const response = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ summary: "ok", items: "not-an-array" }),
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const { client } = fakeClient(response);

    await expect(
      new AnthropicProvider(client).complete(makeRequest()),
    ).rejects.toThrow();
  });
});

describe("summarize", () => {
  it("collapses whitespace to single spaces and trims", () => {
    expect(summarize("a\n\n  b\tc  ")).toBe("a b c");
  });

  it("truncates with an ellipsis at the boundary", () => {
    const out = summarize("abcdefghij", 5);
    expect(out).toHaveLength(5);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched", () => {
    expect(summarize("short")).toBe("short");
  });
});

describe("getProvider() selection", () => {
  // Snapshot and restore the env var so these cases don't leak into each other
  // or the rest of the suite.
  const original = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it("returns the MockProvider when no key is set (offline default)", () => {
    expect(getProvider()).toBeInstanceOf(MockProvider);
    expect(getProvider().name).toBe("mock");
  });

  it("treats an empty/whitespace key as unset → MockProvider", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(getProvider()).toBeInstanceOf(MockProvider);
  });

  it("returns the AnthropicProvider when a key is set (no network call)", () => {
    // Construction only — `complete()` is never invoked, so no request is made.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
    const provider = getProvider();
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
  });
});
