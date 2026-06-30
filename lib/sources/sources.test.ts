import { describe, it, expect } from "vitest";

import { getConnector } from "@/lib/connectors";
import { buildSourceIndex } from "./index";

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
