import { describe, it, expect } from "vitest";

import { verifyReferences, verifyItems } from "./verify";

/**
 * Tests for the deterministic reference verifier. These pin the offline
 * faithfulness guarantee: a citation to a nonexistent id must be caught, an
 * uncited claim must be caught, and a fully-cited batch must pass with the
 * correct rate. Ids use the contract's namespaced form (commit:/pr:/ticket:).
 */
describe("verifyReferences (single item)", () => {
  const valid = new Set(["pr:42", "commit:abc1234", "ticket:FAPI-1"]);

  it("passes when every cited id is real", () => {
    const r = verifyReferences(["pr:42", "ticket:FAPI-1"], valid);
    expect(r.ok).toBe(true);
    expect(r.empty).toBe(false);
    expect(r.unknownIds).toEqual([]);
  });

  it("flags a fabricated citation and names the offending id", () => {
    const r = verifyReferences(["pr:42", "pr:9999"], valid);
    expect(r.ok).toBe(false);
    expect(r.empty).toBe(false);
    // The specific bad id is surfaced so the repair prompt can target it.
    expect(r.unknownIds).toEqual(["pr:9999"]);
  });

  it("treats an empty citation list as an ungrounded (not-ok) claim", () => {
    const r = verifyReferences([], valid);
    expect(r.ok).toBe(false);
    expect(r.empty).toBe(true);
    expect(r.unknownIds).toEqual([]);
  });

  it("reports every unknown id when multiple are fabricated", () => {
    const r = verifyReferences(["pr:9999", "ticket:NOPE-1"], valid);
    expect(r.ok).toBe(false);
    expect(r.unknownIds).toEqual(["pr:9999", "ticket:NOPE-1"]);
  });
});

describe("verifyItems (batch report)", () => {
  const valid = new Set(["pr:42", "pr:43", "commit:abc1234"]);

  it("passes an all-valid batch with rate 1 and no flags", () => {
    const report = verifyItems(
      [{ sources: ["pr:42"] }, { sources: ["pr:43", "commit:abc1234"] }],
      valid,
    );
    expect(report.totalItems).toBe(2);
    expect(report.supportedItems).toBe(2);
    expect(report.rate).toBe(1);
    expect(report.flagged).toEqual([]);
  });

  it("FAULT INJECTION: a planted bad citation is flagged at its index", () => {
    // Item 1 cites a PR that does not exist in the release window. The verifier
    // must catch it even though items 0 and 2 are perfectly grounded.
    const items = [
      { sources: ["pr:42"] }, // good
      { sources: ["pr:9999"] }, // planted hallucination
      { sources: ["commit:abc1234"] }, // good
    ];
    const report = verifyItems(items, valid);

    expect(report.totalItems).toBe(3);
    expect(report.supportedItems).toBe(2);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].index).toBe(1);
    expect(report.flagged[0].issue).toContain("pr:9999");
    expect(report.rate).toBeCloseTo(2 / 3);
  });

  it("flags empty-source items with an ungrounded reason", () => {
    const report = verifyItems(
      [{ sources: ["pr:42"] }, { sources: [] }],
      valid,
    );
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].index).toBe(1);
    expect(report.flagged[0].issue).toMatch(/no sources|ungrounded/i);
  });

  it("computes rate correctly with several flagged items", () => {
    const report = verifyItems(
      [
        { sources: ["pr:42"] }, // ok
        { sources: [] }, // empty
        { sources: ["pr:9999"] }, // unknown
        { sources: ["pr:43"] }, // ok
      ],
      valid,
    );
    expect(report.supportedItems).toBe(2);
    expect(report.flagged.map((f) => f.index)).toEqual([1, 2]);
    expect(report.rate).toBe(0.5);
  });

  it("treats an empty batch as vacuously fully supported (rate 1)", () => {
    // WHY: the repair gate keys off flagged.length; "nothing to generate" must
    // not look like a faithfulness failure (and must never divide by zero).
    const report = verifyItems([], valid);
    expect(report.totalItems).toBe(0);
    expect(report.rate).toBe(1);
    expect(report.flagged).toEqual([]);
  });
});
