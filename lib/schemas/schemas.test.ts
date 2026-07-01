import { describe, it, expect } from "vitest";
import {
  CommitSchema,
  ChangeSchema,
  TicketSchema,
  ReleaseArtifactsSchema,
} from "./index";

/**
 * Smoke tests for the shared contract. These also pin two architectural
 * invariants the whole pipeline relies on:
 *  - sensible defaults so connectors can supply partial source data, and
 *  - the grounding guarantee: a Change cannot exist without provenance.
 */
describe("schema contract", () => {
  it("applies defaults for optional source-artifact fields", () => {
    const c = CommitSchema.parse({
      id: "commit:abc1234",
      sha: "abc1234",
      message: "Fix things (#42)",
      author: "octocat",
      date: "2026-01-01T00:00:00Z",
    });
    expect(c.files).toEqual([]);
    expect(c.prNumbers).toEqual([]);
    expect(c.ticketKeys).toEqual([]);
  });

  it("models tickets in Jira shape with defaults", () => {
    const t = TicketSchema.parse({ id: "ticket:FAPI-1", key: "FAPI-1", summary: "Do X" });
    expect(t.issueType).toBe("task");
    expect(t.status).toBe("Done");
  });

  it("enforces the grounding guarantee: a Change needs >=1 source id", () => {
    expect(() =>
      ChangeSchema.parse({ id: "c1", type: "feature", summary: "s", sourceIds: [] }),
    ).toThrow();
    const ok = ChangeSchema.parse({
      id: "c1",
      type: "feature",
      summary: "s",
      sourceIds: ["pr:42"],
    });
    expect(ok.isBreaking).toBe(false);
  });

  it("accepts a minimal well-formed artifacts object", () => {
    const a = ReleaseArtifactsSchema.parse({
      changelog: [{ category: "Features", text: "Added X", sources: ["pr:42"] }],
      internalReleaseNotes: [{ heading: "Overview", body: "..." }],
      customerReleaseNotes: [{ heading: "What's new", body: "..." }],
      documentationUpdates: [],
    });
    expect(a.changelog).toHaveLength(1);
    expect(a.internalReleaseNotes[0].sources).toEqual([]);
  });
});
