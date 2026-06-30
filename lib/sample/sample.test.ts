import { describe, it, expect } from "vitest";

import { ReleasePackageSchema } from "@/lib/schemas";
import { toSpecOutput, type SpecOutput } from "@/lib/export";
import { SAMPLE_PACKAGE } from "./releasePackage";

/**
 * Smoke tests for the UI's data layer. They pin two things the dashboard relies
 * on and that are cheap to break:
 *  - the sample stays a valid, *grounded* ReleasePackage (the contract), and
 *  - the export renders the spec's exact snake_case shape with provenance intact.
 * Both are pure (no DOM), so they run under the existing vitest config unchanged.
 */
describe("SAMPLE_PACKAGE", () => {
  it("is a valid ReleasePackage (re-validates the contract)", () => {
    // .parse already runs at import; re-parsing here makes the invariant explicit
    // and fails loudly if the export shape ever diverges from the package.
    expect(() => ReleasePackageSchema.parse(SAMPLE_PACKAGE)).not.toThrow();
  });

  it("grounds every generated artifact with at least one source id", () => {
    const a = SAMPLE_PACKAGE.artifacts;
    for (const e of a.changelog) expect(e.sources.length).toBeGreaterThan(0);
    for (const u of a.documentationUpdates)
      expect(u.sources.length).toBeGreaterThan(0);
    // Notes may legitimately have zero sources per schema, so we don't assert there.
  });

  it("uses only namespaced source ids (commit:/pr:/ticket:)", () => {
    const ids = SAMPLE_PACKAGE.artifacts.changelog.flatMap((e) => e.sources);
    for (const id of ids) {
      expect(id).toMatch(/^(commit|pr|ticket):/);
    }
  });

  it("every DocUpdate.retrievedChunkId resolves to a retrieval chunk", () => {
    const known = new Set(SAMPLE_PACKAGE.retrieval.map((c) => c.id));
    for (const u of SAMPLE_PACKAGE.artifacts.documentationUpdates) {
      if (u.retrievedChunkId !== null) {
        expect(known.has(u.retrievedChunkId)).toBe(true);
      }
    }
  });

  it("resolves every cited source id in sourceIndex (readable, complete)", () => {
    const a = SAMPLE_PACKAGE.artifacts;
    const cited = new Set<string>([
      ...a.changelog.flatMap((e) => e.sources),
      ...a.internalReleaseNotes.flatMap((n) => n.sources),
      ...a.customerReleaseNotes.flatMap((n) => n.sources),
      ...a.documentationUpdates.flatMap((u) => u.sources),
    ]);
    for (const id of cited) {
      const ref = SAMPLE_PACKAGE.sourceIndex[id];
      expect(ref, `missing sourceIndex entry for ${id}`).toBeDefined();
      expect(ref.title.length).toBeGreaterThan(0);
    }
    // PRs/commits link out to GitHub; reconstructed tickets carry no url.
    const pr = SAMPLE_PACKAGE.sourceIndex["pr:15745"];
    expect(pr.url).toBe("https://github.com/fastapi/fastapi/pull/15745");
    expect(SAMPLE_PACKAGE.sourceIndex["ticket:FAPI-1003"].url).toBeNull();
  });
});

describe("toSpecOutput", () => {
  const spec: SpecOutput = toSpecOutput(SAMPLE_PACKAGE.artifacts);

  it("emits the spec's snake_case top-level keys", () => {
    expect(Object.keys(spec).sort()).toEqual([
      "changelog",
      "customer_release_notes",
      "documentation_updates",
      "internal_release_notes",
    ]);
  });

  it("maps documentation updates to snake_case and preserves sources", () => {
    const first = spec.documentation_updates[0];
    const src = SAMPLE_PACKAGE.artifacts.documentationUpdates[0];
    expect(first.doc_path).toBe(src.docPath);
    expect(first.is_possible_doc_debt).toBe(src.isPossibleDocDebt);
    expect(first.sources).toEqual(src.sources);
  });

  it("preserves item counts across the mapping", () => {
    expect(spec.changelog).toHaveLength(
      SAMPLE_PACKAGE.artifacts.changelog.length,
    );
    expect(spec.internal_release_notes).toHaveLength(
      SAMPLE_PACKAGE.artifacts.internalReleaseNotes.length,
    );
    expect(spec.customer_release_notes).toHaveLength(
      SAMPLE_PACKAGE.artifacts.customerReleaseNotes.length,
    );
  });
});
