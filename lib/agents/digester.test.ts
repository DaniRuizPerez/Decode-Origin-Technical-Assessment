import { describe, it, expect } from "vitest";

import { getConnector } from "@/lib/connectors";
import { MockProvider } from "@/lib/llm";
import { ChangeSetSchema, type LLMProvider, type ReleaseInput } from "@/lib/schemas";

import { buildDeterministicChangeSet, digest } from "./digester";

/**
 * These tests run the Digester against the REAL committed fixtures (the harvested
 * FastAPI 0.136.0…0.137.2 window) through the offline MockProvider — no network,
 * no API key. Because the MockProvider returns the agent's grounded `fallback`
 * verbatim, asserting on `digest(...)` is asserting on the deterministic baseline,
 * which is exactly the path the offline product ships.
 */
describe("digester", () => {
  const input: ReleaseInput = getConnector().loadReleaseInput();

  /** Every real artifact id in the window — the grounding allow-list. */
  const validIds = new Set<string>([
    ...input.commits.map((c) => c.id),
    ...input.pullRequests.map((p) => p.id),
    ...input.tickets.map((t) => t.id),
  ]);

  /** The 7 reconstructed tickets are the substantive-change backbone. */
  const TICKET_KEYS = [
    "FAPI-1000",
    "FAPI-1001",
    "FAPI-1002",
    "FAPI-1003",
    "FAPI-1004",
    "FAPI-1005",
    "FAPI-1006",
  ];

  describe("buildDeterministicChangeSet() — the grounded baseline", () => {
    const changeSet = buildDeterministicChangeSet(input);

    it("produces a schema-valid ChangeSet", () => {
      expect(() => ChangeSetSchema.parse(changeSet)).not.toThrow();
    });

    it("represents all 7 substantive changes, one per ticket", () => {
      // Each substantive change cites exactly one ticket; collect them.
      const citedTicketKeys = new Set<string>();
      for (const change of changeSet.changes) {
        for (const id of change.sourceIds) {
          if (id.startsWith("ticket:")) {
            citedTicketKeys.add(id.replace("ticket:", ""));
          }
        }
      }
      for (const key of TICKET_KEYS) {
        expect(citedTicketKeys.has(key)).toBe(true);
      }
      // 7 substantive (ticket-linked) changes + at most one noise summary.
      const substantive = changeSet.changes.filter((c) =>
        c.sourceIds.some((s) => s.startsWith("ticket:")),
      );
      expect(substantive).toHaveLength(7);
    });

    it("grounds every change: >=1 sourceId and all ids are real", () => {
      expect(changeSet.changes.length).toBeGreaterThan(0);
      for (const change of changeSet.changes) {
        expect(change.sourceIds.length).toBeGreaterThanOrEqual(1);
        for (const id of change.sourceIds) {
          expect(validIds.has(id)).toBe(true);
        }
      }
    });

    it("flags the routing-internals refactor as breaking", () => {
      const breaking = changeSet.changes.filter((c) => c.isBreaking);
      // Exactly the one breaking PR (#15745) in this window.
      expect(breaking).toHaveLength(1);
      expect(breaking[0].type).toBe("breaking");
      expect(breaking[0].sourceIds).toContain("pr:15745");
      expect(breaking[0].sourceIds).toContain("ticket:FAPI-1003");
    });

    it("surfaces a large incomplete-information signal (>100 unlinked)", () => {
      // Most FastAPI PRs/commits are intentionally ticketless (see data/README).
      expect(changeSet.unlinkedArtifactIds.length).toBeGreaterThan(100);
    });

    it("infers types from labels/titles", () => {
      const byTicket = (key: string) =>
        changeSet.changes.find((c) => c.sourceIds.includes(`ticket:${key}`));

      expect(byTicket("FAPI-1006")?.type).toBe("feature"); // ✨ iter_route_contexts
      expect(byTicket("FAPI-1004")?.type).toBe("fix"); // 🐛 empty path
      expect(byTicket("FAPI-1003")?.type).toBe("breaking"); // ♻️ but labelled breaking
      expect(byTicket("FAPI-1000")?.type).toBe("deps"); // ⬆️ pydantic upgrade
    });

    it("infers components from changed file paths", () => {
      const byTicket = (key: string) =>
        changeSet.changes.find((c) => c.sourceIds.includes(`ticket:${key}`));

      // fastapi/routing.py → "routing"; fastapi/sse.py → "sse"; private pkg
      // fastapi/_compat/ normalizes to "compat".
      expect(byTicket("FAPI-1004")?.components).toContain("routing");
      expect(byTicket("FAPI-1001")?.components).toContain("sse");
      expect(byTicket("FAPI-1000")?.components).toContain("compat");
    });

    it("collapses translation/internal/dep noise into one chore change", () => {
      const noise = changeSet.changes.filter((c) => c.id === "chg-internal-noise");
      expect(noise).toHaveLength(1);
      expect(noise[0].type).toBe("chore");
      // Lower confidence than ticket-backed work, and still grounded.
      expect(noise[0].confidence).toBeLessThan(0.7);
      expect(noise[0].sourceIds.length).toBeGreaterThanOrEqual(1);
      for (const id of noise[0].sourceIds) expect(validIds.has(id)).toBe(true);
    });

    it("does NOT promote the release-version-bump PRs to substantive changes", () => {
      // The three `🔖 Release version 0.137.x` PRs touch only fastapi/__init__.py
      // and must collapse into noise, not become Changes of their own.
      const releaseBumpPrIds = ["pr:15748", "pr:15766", "pr:15790"];
      const substantiveSourceIds = new Set(
        changeSet.changes
          .filter((c) => c.id !== "chg-internal-noise")
          .flatMap((c) => c.sourceIds),
      );
      for (const id of releaseBumpPrIds) {
        expect(substantiveSourceIds.has(id)).toBe(false);
      }
    });

    it("keeps a clean one-line summary (strips leading gitmoji)", () => {
      const feature = changeSet.changes.find((c) =>
        c.sourceIds.includes("ticket:FAPI-1006"),
      );
      expect(feature?.summary.startsWith("Add ")).toBe(true);
      // No leading gitmoji left over.
      expect(feature?.summary).not.toMatch(/^[^A-Za-z0-9]/);
    });

    it("scores ticket-backed changes with high confidence", () => {
      const ticketed = changeSet.changes.filter((c) =>
        c.sourceIds.some((s) => s.startsWith("ticket:")),
      );
      for (const c of ticketed) {
        expect(c.confidence).toBeGreaterThanOrEqual(0.7);
      }
    });
  });

  describe("digest() — offline (MockProvider) returns the grounded baseline", () => {
    it("returns the deterministic change set verbatim offline", async () => {
      const baseline = buildDeterministicChangeSet(input);
      const result = await digest(input, new MockProvider());
      // MockProvider echoes the fallback (re-parsed), so the offline product IS
      // the deterministic baseline.
      expect(result).toEqual(baseline);
    });

    it("produces a schema-valid result via the provider path", async () => {
      const result = await digest(input, new MockProvider());
      expect(() => ChangeSetSchema.parse(result)).not.toThrow();
    });

    it("repairs a fabricated citation in the loop (hybrid grounding online)", async () => {
      // Simulate a non-mock LLM: emit a hallucinated source id on the first call,
      // then a grounded answer on the repair call. This proves digest() wires
      // groundedGenerate correctly — the in-loop verifier catches the bad id and
      // the bounded repair yields a clean, fully-grounded ChangeSet.
      const drafts = [
        {
          // Call 1: cites a PR that doesn't exist in the window.
          changes: [
            {
              id: "chg-bad",
              type: "feature",
              summary: "Hallucinated change",
              sourceIds: ["pr:9999999"],
            },
          ],
          unlinkedArtifactIds: [],
        },
        {
          // Call 2 (repair): cites a real id from the window.
          changes: [
            {
              id: "chg-good",
              type: "feature",
              summary: "Grounded change",
              sourceIds: ["pr:15785"],
            },
          ],
          unlinkedArtifactIds: [],
        },
      ];

      let call = 0;
      const scriptedProvider: LLMProvider = {
        name: "stub",
        async complete<U>(req: { schema: { parse(v: unknown): U } }) {
          const draft = drafts[Math.min(call, drafts.length - 1)];
          call += 1;
          return {
            value: req.schema.parse(draft),
            trace: {
              agent: "digester",
              provider: "stub",
              ms: 1,
              inputSummary: "in",
              outputSummary: "out",
              tokens: null,
            },
          };
        },
      };

      const result = await digest(input, scriptedProvider);
      // The repair fired (two provider calls) and the accepted value is grounded.
      expect(call).toBe(2);
      const cited = new Set(result.changes.flatMap((c) => c.sourceIds));
      for (const id of cited) expect(validIds.has(id)).toBe(true);
    });
  });
});
