import { describe, it, expect } from "vitest";

import { runPipeline } from "./pipeline";
import { ReleasePackageSchema } from "@/lib/schemas";

/**
 * End-to-end pipeline check against the REAL fixtures. With no ANTHROPIC_API_KEY
 * the whole run resolves to the deterministic mock provider, so this is
 * network-free and stable. Beyond the smoke check, it pins the new `sourceIndex`:
 * the distinct ids cited across all artifacts must resolve to readable titles and
 * canonical GitHub urls.
 */
describe("runPipeline", () => {
  it("produces a valid, grounded ReleasePackage with a populated sourceIndex", async () => {
    const pkg = await runPipeline();

    // Contract holds end-to-end.
    expect(() => ReleasePackageSchema.parse(pkg)).not.toThrow();

    // Every id cited by any artifact is resolved in the index.
    const cited = new Set<string>();
    for (const e of pkg.artifacts.changelog) e.sources.forEach((s) => cited.add(s));
    for (const n of pkg.artifacts.internalReleaseNotes)
      n.sources.forEach((s) => cited.add(s));
    for (const n of pkg.artifacts.customerReleaseNotes)
      n.sources.forEach((s) => cited.add(s));
    for (const d of pkg.artifacts.documentationUpdates)
      d.sources.forEach((s) => cited.add(s));

    expect(cited.size).toBeGreaterThan(0);
    for (const id of cited) {
      expect(pkg.sourceIndex[id]).toBeDefined();
      expect(pkg.sourceIndex[id].id).toBe(id);
    }
    // The index holds exactly the cited ids — nothing extra, nothing missing.
    expect(Object.keys(pkg.sourceIndex).sort()).toEqual([...cited].sort());
  });

  it("resolves PR #15745 to its title and the correct /pull/15745 url", async () => {
    const pkg = await runPipeline();
    const ref = pkg.sourceIndex["pr:15745"];
    expect(ref).toBeDefined();
    expect(ref.kind).toBe("pr");
    expect(ref.title.length).toBeGreaterThan(0);
    expect(ref.url).toBe("https://github.com/fastapi/fastapi/pull/15745");
  });

  it("populates docIndex for every docPath referenced by doc updates + retrieval", async () => {
    const pkg = await runPipeline();

    // Distinct docPaths referenced by the documentation updates and retrieval chunks.
    const referenced = new Set<string>();
    for (const d of pkg.artifacts.documentationUpdates) referenced.add(d.docPath);
    for (const c of pkg.retrieval) referenced.add(c.docPath);

    expect(referenced.size).toBeGreaterThan(0);
    for (const docPath of referenced) {
      const ref = pkg.docIndex[docPath];
      expect(ref, `missing docIndex entry for ${docPath}`).toBeDefined();
      expect(ref.docPath).toBe(docPath);
    }
    // The index holds exactly the referenced docPaths — nothing extra, nothing missing.
    expect(Object.keys(pkg.docIndex).sort()).toEqual([...referenced].sort());
  });

  it("resolves tutorial__bigger-applications.md to its GitHub blob url at the harvested ref", async () => {
    const pkg = await runPipeline();
    const ref = pkg.docIndex["tutorial__bigger-applications.md"];
    expect(ref).toBeDefined();
    expect(ref.sourcePath).toBe("docs/en/docs/tutorial/bigger-applications.md");
    expect(ref.url).toBe(
      "https://github.com/fastapi/fastapi/blob/0.136.0/docs/en/docs/tutorial/bigger-applications.md",
    );
  });

  it("surfaces retrieval evidence with real RRF scores + signals (not the old hardcoded 1)", async () => {
    const pkg = await runPipeline();
    expect(pkg.retrieval.length).toBeGreaterThan(0);
    for (const c of pkg.retrieval) {
      // Real fused RRF score (~1/(k+rank)), not the previous hardcoded 1.
      expect(c.score).toBeGreaterThan(0);
      expect(c.score).not.toBe(1);
      // At least one real signal carried through from the retriever.
      expect(c.signals.bm25 != null || c.signals.dense != null).toBe(true);
    }
  });
});
