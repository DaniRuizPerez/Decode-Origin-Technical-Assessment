import { describe, it, expect } from "vitest";

import { chunkDoc, chunkDocs } from "./chunk";

describe("chunkDoc", () => {
  it("yields one chunk per section, each tagged with its heading", () => {
    const md = [
      "# Title",
      "Intro under the title.",
      "",
      "## Section A",
      "Body of A.",
      "",
      "## Section B",
      "Body of B.",
    ].join("\n");

    const chunks = chunkDoc("doc.md", md);

    // Three headings → three chunks (no preamble before the first heading).
    expect(chunks.map((c) => c.section)).toEqual([
      "Title",
      "Section A",
      "Section B",
    ]);
    // Each chunk's body includes its own heading line plus its content.
    expect(chunks[1].text).toContain("## Section A");
    expect(chunks[1].text).toContain("Body of A.");
    // Content from a later section must not bleed into an earlier one.
    expect(chunks[1].text).not.toContain("Body of B.");
  });

  it("strips the FastAPI `{ #anchor }` suffix from the section heading", () => {
    const md = "## `APIRouter` { #apirouter }\nUse it.";
    const [chunk] = chunkDoc("doc.md", md);
    // The anchor machinery is dropped; the human-readable heading is kept.
    expect(chunk.section).toBe("`APIRouter`");
    expect(chunk.id).toBe("doc.md#0:apirouter");
  });

  it("does NOT treat `#` comments inside fenced code blocks as headings", () => {
    // Mirrors the real FastAPI doc, which has `# ...` comments inside a ``` block.
    const md = [
      "# Real Heading",
      "Before the fence.",
      "",
      "```bash",
      "# this is a shell comment, not a heading",
      "## also not a heading",
      "```",
      "After the fence.",
    ].join("\n");

    const chunks = chunkDoc("doc.md", md);
    // Exactly one section: the fenced `#` lines must not split it.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe("Real Heading");
    expect(chunks[0].text).toContain("# this is a shell comment");
  });

  it("captures a preamble before the first heading as its own chunk", () => {
    const md = ["Leading prose with no heading.", "", "## First", "Body."].join(
      "\n",
    );
    const chunks = chunkDoc("doc.md", md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe("(preamble)");
    expect(chunks[0].text).toContain("Leading prose");
    expect(chunks[1].section).toBe("First");
  });

  it("treats a doc with no headings as a single preamble chunk", () => {
    const chunks = chunkDoc("doc.md", "Just a paragraph.\nAnd another line.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe("(preamble)");
  });

  it("produces stable, unique ids from docPath + section + index", () => {
    // Two sections sharing a heading must still get distinct ids (index breaks it).
    const md = ["## Notes", "first", "", "## Notes", "second"].join("\n");
    const chunks = chunkDoc("d.md", md);
    expect(chunks.map((c) => c.id)).toEqual(["d.md#0:notes", "d.md#1:notes"]);

    // Re-chunking the same input is byte-for-byte reproducible.
    expect(chunkDoc("d.md", md)).toEqual(chunks);
  });

  it("keeps an empty named section retrievable (heading with no body)", () => {
    const md = ["## Empty", "", "## Full", "content"].join("\n");
    const chunks = chunkDoc("d.md", md);
    expect(chunks.map((c) => c.section)).toEqual(["Empty", "Full"]);
  });

  it("handles CRLF line endings", () => {
    const md = "# A\r\nbody\r\n## B\r\nmore";
    const chunks = chunkDoc("d.md", md);
    expect(chunks.map((c) => c.section)).toEqual(["A", "B"]);
    // No stray carriage returns survive into the heading text.
    expect(chunks[0].section).toBe("A");
  });
});

describe("chunkDocs", () => {
  it("flattens multiple docs into one corpus, ids namespaced by docPath", () => {
    const chunks = chunkDocs([
      { docPath: "a.md", text: "# A\nbody" },
      { docPath: "b.md", text: "# B\nbody" },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].id.startsWith("a.md#")).toBe(true);
    expect(chunks[1].id.startsWith("b.md#")).toBe(true);
  });
});
