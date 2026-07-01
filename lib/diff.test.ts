import { describe, it, expect } from "vitest";

import { diffLines } from "./diff";

describe("diffLines", () => {
  it("marks an inserted block as added, keeping surrounding context (the offline doc-edit case)", () => {
    const before = "## Heading\nbody one\nbody two";
    const after = "## Heading\n\n> note\nbody one\nbody two";
    const rows = diffLines(before, after);
    expect(rows.filter((r) => r.type === "del")).toHaveLength(0);
    expect(rows.filter((r) => r.type === "add").map((r) => r.text)).toEqual(["", "> note"]);
    expect(rows.filter((r) => r.type === "ctx").map((r) => r.text)).toEqual([
      "## Heading",
      "body one",
      "body two",
    ]);
  });

  it("is all-context for identical text", () => {
    const rows = diffLines("a\nb", "a\nb");
    expect(rows.every((r) => r.type === "ctx")).toBe(true);
  });

  it("shows a replaced middle as removed then added", () => {
    const rows = diffLines("a\nX\nc", "a\nY\nc");
    expect(rows.map((r) => `${r.type}:${r.text}`)).toEqual([
      "ctx:a",
      "del:X",
      "add:Y",
      "ctx:c",
    ]);
  });
});
