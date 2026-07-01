import { describe, it, expect, beforeAll } from "vitest";

import { getConnector } from "@/lib/connectors";
import { MockProvider } from "@/lib/llm";
import {
  ReleasePlanSchema,
  type ChangeSet,
  type ReleaseInput,
} from "@/lib/schemas";

import { digest } from "./digester";
import { buildDeterministicPlan, plan } from "./planner";

/**
 * Planner tests run against the real fixtures via the Digester's actual output,
 * offline through the MockProvider. Driving the Planner with the real ChangeSet
 * (rather than a hand-built one) makes these end-to-end over the understanding
 * pipeline: a regression in either agent surfaces here.
 */
describe("planner", () => {
  const input: ReleaseInput = getConnector().loadReleaseInput();

  // The Digester output offline == its grounded baseline; use it as Planner input.
  // Definite-assignment (`!`): set in beforeAll, read only inside `it` bodies.
  let changeSet!: ChangeSet;
  beforeAll(async () => {
    changeSet = await digest(input, new MockProvider());
  });

  describe("buildDeterministicPlan() — explainable risk + structure", () => {
    it("produces a schema-valid ReleasePlan", () => {
      const releasePlan = buildDeterministicPlan(changeSet, input);
      expect(() => ReleasePlanSchema.parse(releasePlan)).not.toThrow();
    });

    it("rates the release HIGH risk because of the breaking change", () => {
      const { risk } = buildDeterministicPlan(changeSet, input);
      expect(risk.level).toBe("high");
      // The explanation must name the breaking change concretely.
      expect(risk.reasons.length).toBeGreaterThan(0);
      const mentionsBreaking = risk.reasons.some(
        (r) => /breaking/i.test(r) && r.includes("pr:15745"),
      );
      expect(mentionsBreaking).toBe(true);
    });

    it("includes additional explainable risk signals (deps, breadth)", () => {
      const { risk } = buildDeterministicPlan(changeSet, input);
      const joined = risk.reasons.join("\n");
      // Pydantic upgrade is a dependency signal; the window touches >=5 components.
      expect(/dependency|upgrade/i.test(joined)).toBe(true);
      expect(/blast radius|components touched/i.test(joined)).toBe(true);
    });

    it("accounts ticket coverage over the 7 tickets (all covered)", () => {
      const { coverage } = buildDeterministicPlan(changeSet, input);
      expect(coverage.total).toBe(7);
      // Each ticket is cited by its substantive change, so coverage is complete.
      expect(coverage.covered).toBe(7);
      expect(coverage.missingTicketKeys).toEqual([]);
    });

    it("reports a missing ticket when a change set omits it", () => {
      // Drop the breaking change's ticket citation to simulate incomplete linkage.
      const partial: ChangeSet = {
        ...changeSet,
        changes: changeSet.changes.map((c) =>
          c.id === "chg-pr-15745"
            ? { ...c, sourceIds: c.sourceIds.filter((s) => s !== "ticket:FAPI-1003") }
            : c,
        ),
      };
      const { coverage } = buildDeterministicPlan(partial, input);
      expect(coverage.covered).toBe(6);
      expect(coverage.missingTicketKeys).toContain("FAPI-1003");
    });

    it("groups changes into themes referencing only valid change ids", () => {
      const releasePlan = buildDeterministicPlan(changeSet, input);
      const validChangeIds = new Set(changeSet.changes.map((c) => c.id));

      expect(releasePlan.themes.length).toBeGreaterThan(0);
      for (const theme of releasePlan.themes) {
        expect(theme.changeIds.length).toBeGreaterThan(0);
        for (const id of theme.changeIds) {
          expect(validChangeIds.has(id)).toBe(true);
        }
      }
    });

    it("leads with a dedicated breaking-changes theme", () => {
      const releasePlan = buildDeterministicPlan(changeSet, input);
      expect(releasePlan.themes[0].title).toMatch(/breaking/i);
      expect(releasePlan.themes[0].changeIds).toContain("chg-pr-15745");
    });

    it("themes every change id exactly once (no orphans, no duplicates)", () => {
      const releasePlan = buildDeterministicPlan(changeSet, input);
      const themed = releasePlan.themes.flatMap((t) => t.changeIds);
      const themedSet = new Set(themed);
      // No duplicates across themes.
      expect(themed.length).toBe(themedSet.size);
      // Every change is represented.
      for (const c of changeSet.changes) {
        expect(themedSet.has(c.id)).toBe(true);
      }
    });

    it("unions components into affectedSystems", () => {
      const releasePlan = buildDeterministicPlan(changeSet, input);
      const expected = new Set(changeSet.changes.flatMap((c) => c.components));
      expect(new Set(releasePlan.affectedSystems)).toEqual(expected);
      // Spot-check a couple of real components.
      expect(releasePlan.affectedSystems).toContain("routing");
      expect(releasePlan.affectedSystems).toContain("compat");
    });
  });

  describe("risk levels for synthetic change sets", () => {
    const baseChange = {
      id: "c1",
      type: "fix" as const,
      summary: "A small fix",
      details: "",
      components: ["routing"],
      sourceIds: ["pr:15763"],
      isBreaking: false,
    };

    it("rates a quiet single-fix release LOW with an explanation", () => {
      const cs: ChangeSet = { changes: [baseChange], unlinkedArtifactIds: [] };
      const { risk } = buildDeterministicPlan(cs, input);
      expect(risk.level).toBe("low");
      expect(risk.reasons.length).toBeGreaterThan(0); // never empty
    });

    it("rates a dependency-only release MEDIUM", () => {
      const cs: ChangeSet = {
        changes: [
          { ...baseChange, type: "deps", id: "c-dep", components: ["compat"] },
        ],
        unlinkedArtifactIds: [],
      };
      const { risk } = buildDeterministicPlan(cs, input);
      expect(risk.level).toBe("medium");
    });

    it("rates any breaking release HIGH", () => {
      const cs: ChangeSet = {
        changes: [{ ...baseChange, type: "breaking", isBreaking: true }],
        unlinkedArtifactIds: [],
      };
      const { risk } = buildDeterministicPlan(cs, input);
      expect(risk.level).toBe("high");
    });
  });

  describe("plan() — offline (MockProvider) returns the deterministic plan", () => {
    it("returns the deterministic plan verbatim offline", async () => {
      const baseline = buildDeterministicPlan(changeSet, input);
      const result = await plan(changeSet, input, new MockProvider());
      expect(result).toEqual(baseline);
    });

    it("produces a schema-valid result via the provider path", async () => {
      const result = await plan(changeSet, input, new MockProvider());
      expect(() => ReleasePlanSchema.parse(result)).not.toThrow();
    });
  });
});
