import { describe, it, expect } from "vitest";
import { z } from "zod";

import type {
  AgentCallTrace,
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "@/lib/schemas";

import { groundedGenerate } from "./groundedGenerate";

/* ============================================================================
 * Test fixtures: a minimal grounded artifact + stub providers.
 *
 * We use a tiny "changelog" shape (a list of items each carrying `sources`)
 * rather than the full ReleaseArtifacts so the test focuses on the loop
 * mechanics. `extractItems` just returns the entries.
 * ========================================================================== */

const EntrySchema = z.object({
  text: z.string(),
  sources: z.array(z.string()),
});
const DraftSchema = z.object({ entries: z.array(EntrySchema) });
type Draft = z.infer<typeof DraftSchema>;

const extractItems = (value: Draft) => value.entries;

/** The known-good evidence for the release window under test. */
const validSourceIds = new Set(["pr:42", "pr:43", "commit:abc1234"]);

/** A grounded, fully-cited fallback an agent would supply (its extractive baseline). */
const groundedFallback: Draft = {
  entries: [
    { text: "Add streaming responses", sources: ["pr:42"] },
    { text: "Fix header parsing", sources: ["commit:abc1234"] },
  ],
};

/** Build a request with a given fallback; system/prompt are placeholders. */
function makeRequest(fallback: Draft): CompletionRequest<Draft> {
  return {
    agent: "writer",
    system: "You write grounded release notes.",
    prompt: "Summarize the release.",
    schema: DraftSchema,
    fallback,
  };
}

/** A trace stub — shape matches the AgentCallTrace contract. */
function trace(provider: string, outputSummary: string): AgentCallTrace {
  return {
    agent: "writer",
    provider,
    ms: 1,
    inputSummary: "in",
    outputSummary,
    tokens: null,
  };
}

/**
 * Minimal offline MockProvider: returns the request's grounded `fallback`
 * verbatim (mirrors the documented contract — the real MockProvider lives in
 * lib/llm). Used to prove the loop is a clean no-op pass offline.
 */
const mockProvider: LLMProvider = {
  name: "mock",
  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    return { value: req.fallback, trace: trace("mock", "fallback") };
  },
};

/**
 * A scripted stub provider: returns a predetermined value on each successive
 * call, ignoring the request. Lets a test drive the loop through a bad-then-good
 * sequence deterministically without any real LLM.
 */
function scriptedProvider(values: Draft[]): LLMProvider {
  let call = 0;
  return {
    name: "stub",
    async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
      // Clamp to the last scripted value so an over-call can't crash the test;
      // the loop is bounded by maxRepairs anyway.
      const value = values[Math.min(call, values.length - 1)];
      call += 1;
      // The scripted value is the test's Draft; cast through the generic T the
      // provider contract is parameterized on (the request schema is DraftSchema).
      return {
        value: value as unknown as T,
        trace: trace("stub", `call#${call}`),
      };
    },
  };
}

describe("groundedGenerate", () => {
  it("MOCK PATH: returns the grounded fallback with a clean report (no-op loop)", async () => {
    const { value, report, traces } = await groundedGenerate({
      provider: mockProvider,
      request: makeRequest(groundedFallback),
      extractItems,
      validSourceIds,
    });

    // The fallback is already faithful, so we accept it unchanged…
    expect(value).toEqual(groundedFallback);
    // …with a clean report…
    expect(report.rate).toBe(1);
    expect(report.flagged).toEqual([]);
    expect(report.supportedItems).toBe(2);
    // …and exactly ONE provider call (no repair fired).
    expect(traces).toHaveLength(1);
    expect(traces[0].provider).toBe("mock");
  });

  it("REPAIR PATH: bad-then-good demonstrates one bounded repair and trace accumulation", async () => {
    // First draft cites a hallucinated PR; the scripted "repaired" draft fixes it.
    const badDraft: Draft = {
      entries: [
        { text: "Add streaming responses", sources: ["pr:9999"] }, // planted bad id
        { text: "Fix header parsing", sources: ["commit:abc1234"] },
      ],
    };
    const goodDraft: Draft = {
      entries: [
        { text: "Add streaming responses", sources: ["pr:42"] }, // corrected
        { text: "Fix header parsing", sources: ["commit:abc1234"] },
      ],
    };

    const provider = scriptedProvider([badDraft, goodDraft]);

    const { value, report, traces } = await groundedGenerate({
      provider,
      request: makeRequest(groundedFallback),
      extractItems,
      validSourceIds,
    });

    // After one repair the accepted value is the corrected draft…
    expect(value).toEqual(goodDraft);
    // …the final report is clean…
    expect(report.rate).toBe(1);
    expect(report.flagged).toEqual([]);
    // …and BOTH calls (initial + 1 repair) are traced, in order.
    expect(traces).toHaveLength(2);
    expect(traces.map((t) => t.outputSummary)).toEqual(["call#1", "call#2"]);
  });

  it("appends a repair instruction naming the offending id on retry", async () => {
    // Capture the prompt the provider sees on each call to assert the repair
    // instruction was appended (and names the bad id) on the second call.
    const seenPrompts: string[] = [];
    const badDraft: Draft = {
      entries: [{ text: "x", sources: ["pr:9999"] }],
    };
    const goodDraft: Draft = {
      entries: [{ text: "x", sources: ["pr:42"] }],
    };
    let call = 0;
    const provider: LLMProvider = {
      name: "spy",
      async complete<T>(
        req: CompletionRequest<T>,
      ): Promise<CompletionResult<T>> {
        seenPrompts.push(req.prompt);
        const value = (call === 0 ? badDraft : goodDraft) as unknown as T;
        call += 1;
        return { value, trace: trace("spy", `c${call}`) };
      },
    };

    await groundedGenerate({
      provider,
      request: makeRequest(groundedFallback),
      extractItems,
      validSourceIds,
    });

    expect(seenPrompts).toHaveLength(2);
    // First call: original prompt, untouched.
    expect(seenPrompts[0]).toBe("Summarize the release.");
    // Second call: original + repair instruction that names the fabricated id.
    expect(seenPrompts[1]).toContain("Summarize the release.");
    expect(seenPrompts[1]).toContain("GROUNDING REPAIR REQUIRED");
    expect(seenPrompts[1]).toContain("pr:9999");
  });

  it("does NOT mutate the caller's request object across the repair loop", async () => {
    const request = makeRequest(groundedFallback);
    const originalPrompt = request.prompt;
    const provider = scriptedProvider([
      { entries: [{ text: "x", sources: ["pr:9999"] }] },
      { entries: [{ text: "x", sources: ["pr:42"] }] },
    ]);

    await groundedGenerate({
      provider,
      request,
      extractItems,
      validSourceIds,
    });

    // The wrapper clones the request to append the repair instruction; the
    // caller's object must be untouched so it can be safely reused.
    expect(request.prompt).toBe(originalPrompt);
  });

  it("BOUNDED: stops after maxRepairs and reports the residual failure (no infinite loop)", async () => {
    // Provider never produces a clean draft. With maxRepairs=1 we expect exactly
    // 2 calls (initial + 1 repair) and the final report still flagged — surfaced,
    // not thrown.
    const alwaysBad: Draft = {
      entries: [{ text: "x", sources: ["pr:9999"] }],
    };
    const provider = scriptedProvider([alwaysBad]);

    const { report, traces } = await groundedGenerate({
      provider,
      request: makeRequest(groundedFallback),
      extractItems,
      validSourceIds,
      maxRepairs: 1,
    });

    expect(traces).toHaveLength(2);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].issue).toContain("pr:9999");
    expect(report.rate).toBe(0);
  });

  it("honors maxRepairs=0 (verify-only, never retries)", async () => {
    const provider = scriptedProvider([
      { entries: [{ text: "x", sources: ["pr:9999"] }] },
    ]);

    const { traces, report } = await groundedGenerate({
      provider,
      request: makeRequest(groundedFallback),
      extractItems,
      validSourceIds,
      maxRepairs: 0,
    });

    // No repair attempt at all — one call, failure reported.
    expect(traces).toHaveLength(1);
    expect(report.flagged).toHaveLength(1);
  });
});
