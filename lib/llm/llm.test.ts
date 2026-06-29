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
 * NO network and NO API key. They cover the three guarantees the system leans on
 * — mock determinism, schema validation on the same path as the real provider,
 * and key-gated `getProvider()` selection — without ever calling Claude.
 *
 * `AnthropicProvider` is intentionally NOT executed (it needs a key + network);
 * we only assert that `getProvider()` *selects* it when a key is present.
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
