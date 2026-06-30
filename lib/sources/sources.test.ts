import { describe, it, expect } from "vitest";

import { getConnector } from "@/lib/connectors";
import { buildSourceIndex, buildDocIndex } from "./index";

/**
 * Runs against the REAL committed fixtures (the harvested FastAPI
 * 0.136.0…0.137.2 window), so this doubles as a contract check: the well-known
 * ids below (PR #15745, its commit, ticket FAPI-1003) must resolve to readable
 * titles and the canonical GitHub URLs. If a re-harvest drops or renames them,
 * these fail loudly.
 */
describe("buildSourceIndex", () => {
  const input = getConnector().loadReleaseInput();

  it("resolves a PR id to its title + canonical /pull/<number> url", () => {
    const index = buildSourceIndex(input, ["pr:15745"]);
    const ref = index["pr:15745"];
    expect(ref.kind).toBe("pr");
    expect(ref.title.length).toBeGreaterThan(0);
    expect(ref.url).toBe("https://github.com/fastapi/fastapi/pull/15745");
    // Title comes from the real pull, not a fabricated string.
    const pull = input.pullRequests.find((p) => p.id === "pr:15745");
    expect(ref.title).toBe(pull!.title);
  });

  it("resolves a commit id to its subject + /commit/<full-sha> url", () => {
    const index = buildSourceIndex(input, ["commit:8e1d774"]);
    const ref = index["commit:8e1d774"];
    const commit = input.commits.find((c) => c.id === "commit:8e1d774")!;
    expect(ref.kind).toBe("commit");
    // Title is the FIRST line of the (possibly multi-line) commit message.
    expect(ref.title).toBe(commit.message.split("\n")[0].trim());
    // URL uses the FULL sha, not the 7-char short sha embedded in the id.
    expect(ref.url).toBe(
      `https://github.com/fastapi/fastapi/commit/${commit.sha}`,
    );
    expect(commit.sha.length).toBeGreaterThan(7);
  });

  it("resolves a ticket id to its summary with a null url (reconstructed)", () => {
    const index = buildSourceIndex(input, ["ticket:FAPI-1003"]);
    const ref = index["ticket:FAPI-1003"];
    const ticket = input.tickets.find((t) => t.id === "ticket:FAPI-1003")!;
    expect(ref.kind).toBe("ticket");
    expect(ref.title).toBe(ticket.summary);
    expect(ref.url).toBeNull();
  });

  it("degrades an unknown id to kind 'other' with the id as the title", () => {
    const index = buildSourceIndex(input, ["chunk:does-not-exist", "pr:000000"]);
    expect(index["chunk:does-not-exist"]).toEqual({
      id: "chunk:does-not-exist",
      kind: "other",
      title: "chunk:does-not-exist",
      url: null,
    });
    // A namespaced-but-missing PR also degrades rather than throwing.
    expect(index["pr:000000"].kind).toBe("other");
    expect(index["pr:000000"].url).toBeNull();
  });

  it("resolves only the cited ids (does not index the whole window)", () => {
    const index = buildSourceIndex(input, ["pr:15745", "ticket:FAPI-1003"]);
    expect(Object.keys(index).sort()).toEqual(["pr:15745", "ticket:FAPI-1003"]);
  });

  it("tolerates duplicate cited ids", () => {
    const index = buildSourceIndex(input, ["pr:15745", "pr:15745"]);
    expect(Object.keys(index)).toEqual(["pr:15745"]);
  });
});

/**
 * Runs against the REAL harvested docs (`data/mocks/docs/*.md`), so this doubles
 * as a contract check on the first-line provenance comment that
 * `scripts/harvest.ts` writes (`<!-- source: <path> @ <ref> -->`). If a re-harvest
 * changes that format, or drops a well-known doc, these fail loudly.
 */
describe("buildDocIndex", () => {
  const docs = getConnector().loadDocs();
  const project = getConnector().loadReleaseInput().release.project;

  it("resolves a flattened docPath to its original path + GitHub blob url at the harvested ref", () => {
    const index = buildDocIndex(docs, project, [
      "tutorial__bigger-applications.md",
    ]);
    const ref = index["tutorial__bigger-applications.md"];
    expect(ref.docPath).toBe("tutorial__bigger-applications.md");
    // sourcePath + ref come from the doc's first-line comment, not a hardcoded rule.
    expect(ref.sourcePath).toBe("docs/en/docs/tutorial/bigger-applications.md");
    expect(ref.url).toBe(
      "https://github.com/fastapi/fastapi/blob/0.136.0/docs/en/docs/tutorial/bigger-applications.md",
    );
  });

  it("derives the url as https://github.com/<project>/blob/<ref>/<sourcePath>", () => {
    // Cross-check the url format directly against the parsed first line of a real doc.
    const docPath = "advanced__openapi-callbacks.md";
    const doc = docs.find((d) => d.docPath === docPath)!;
    const m = /^<!--\s*source:\s*(.+?)\s*@\s*(.+?)\s*-->/.exec(
      doc.text.split("\n")[0],
    )!;
    const [, sourcePath, gitRef] = m;
    const index = buildDocIndex(docs, project, [docPath]);
    expect(index[docPath].sourcePath).toBe(sourcePath);
    expect(index[docPath].url).toBe(
      `https://github.com/${project}/blob/${gitRef}/${sourcePath}`,
    );
  });

  it("degrades a doc with no parseable source comment to sourcePath=docPath, url=null", () => {
    const index = buildDocIndex(
      [{ docPath: "no-comment.md", text: "# A doc with no provenance line\n" }],
      project,
      ["no-comment.md"],
    );
    expect(index["no-comment.md"]).toEqual({
      docPath: "no-comment.md",
      sourcePath: "no-comment.md",
      url: null,
    });
  });

  it("degrades an unknown (missing) docPath rather than throwing", () => {
    const index = buildDocIndex(docs, project, ["does-not-exist.md"]);
    expect(index["does-not-exist.md"]).toEqual({
      docPath: "does-not-exist.md",
      sourcePath: "does-not-exist.md",
      url: null,
    });
  });

  it("resolves only the referenced docPaths (does not index all 60 docs)", () => {
    const index = buildDocIndex(docs, project, [
      "tutorial__bigger-applications.md",
      "tutorial__header-params.md",
    ]);
    expect(Object.keys(index).sort()).toEqual([
      "tutorial__bigger-applications.md",
      "tutorial__header-params.md",
    ]);
  });

  it("tolerates duplicate referenced docPaths", () => {
    const index = buildDocIndex(docs, project, [
      "tutorial__header-params.md",
      "tutorial__header-params.md",
    ]);
    expect(Object.keys(index)).toEqual(["tutorial__header-params.md"]);
  });
});
