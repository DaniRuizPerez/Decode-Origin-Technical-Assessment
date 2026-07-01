/**
 * Release Writer tests — offline, MockProvider only (no network, no key).
 *
 * The fixtures are small but real-derived: every artifact id below is a genuine
 * id from the frozen FastAPI `0.136.0 … 0.137.2` window (see data/mocks/), so the
 * grounding assertions exercise real provenance, not invented strings.
 *
 * One feature summary deliberately carries a trailing `(#15785)` so the
 * customer-notes scrub is proven on text that actually contains a PR number.
 */

import { describe, it, expect } from "vitest";

import { MockProvider } from "@/lib/llm";
import { ChangeSetSchema, ReleasePlanSchema } from "@/lib/schemas";

import { write } from "./writer";

/** A compact, real-derived change set spanning a breaking change, a feature, fixes, a refactor, and a ticketless docs PR. */
const CHANGE_SET = ChangeSetSchema.parse({
  changes: [
    {
      id: "chg-routing-refactor",
      type: "breaking",
      summary: "Refactor internals to preserve APIRouter and APIRoute instances",
      details:
        "include_router no longer flattens sub-routers; router.routes is now a tree.",
      components: ["routing", "applications"],
      sourceIds: ["ticket:FAPI-1003", "pr:15745", "commit:8e1d774"],
      isBreaking: true,
    },
    {
      id: "chg-iter-route-contexts",
      type: "feature",
      // Trailing PR ref on purpose: proves the customer-note scrubber strips it.
      summary:
        "Add iter_route_contexts() for advanced use cases that used to read router.routes (#15785)",
      details: "Supported replacement for walking router.routes.",
      components: ["routing"],
      sourceIds: ["ticket:FAPI-1006", "pr:15785", "commit:6ac1220"],
      isBreaking: false,
    },
    {
      id: "chg-underscore-headers",
      type: "refactor",
      summary:
        "Do not accept underscore headers when using convert_underscores=True",
      details: "Header params with underscores are no longer matched by default.",
      components: ["params", "routing"],
      sourceIds: ["ticket:FAPI-1002", "pr:15589", "commit:063b5bf"],
      isBreaking: false,
    },
    {
      id: "chg-empty-path-prefixless",
      type: "fix",
      summary: "Allow empty path in path operation in a prefixless router",
      components: ["routing"],
      sourceIds: ["ticket:FAPI-1004", "pr:15763", "commit:d8aad20"],
      isBreaking: false,
    },
    {
      id: "chg-docs-i18n",
      type: "docs",
      summary: "Add and update translations across the documentation",
      components: ["docs"],
      sourceIds: ["pr:15760"],
      isBreaking: false,
    },
  ],
  unlinkedArtifactIds: ["pr:15760"],
});

const PLAN = ReleasePlanSchema.parse({
  themes: [
    {
      title: "Routing internals overhaul",
      summary: "APIRouter/APIRoute instances are preserved in a route tree.",
      changeIds: ["chg-routing-refactor", "chg-iter-route-contexts"],
    },
  ],
  affectedSystems: ["routing", "params", "docs"],
  risk: {
    level: "high",
    reasons: [
      "Breaking change to include_router / router.routes semantics affects a core API.",
      "Default header-handling change can silently break clients using underscore header names.",
    ],
  },
  coverage: { total: 5, covered: 4, missingTicketKeys: ["pr:15760"] },
});

/** Every artifact id legitimately citable for this change set. */
const VALID_IDS = new Set(CHANGE_SET.changes.flatMap((c) => c.sourceIds));

/** Internal-identifier patterns that must NOT appear in customer-note bodies. */
const RAW_ID_RE = /\b(?:pr|commit|ticket):[A-Za-z0-9._-]+/i;
const PR_NUMBER_RE = /#\d+/;

describe("write (offline / MockProvider)", () => {
  it("produces a categorized, fully-grounded changelog (one entry per change)", async () => {
    const { changelog } = await write(CHANGE_SET, PLAN, new MockProvider());

    // One entry per change.
    expect(changelog).toHaveLength(CHANGE_SET.changes.length);

    // Every entry cites >=1 VALID source id.
    for (const entry of changelog) {
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const id of entry.sources) expect(VALID_IDS.has(id)).toBe(true);
    }

    // The breaking change is categorized as such and sorts first.
    expect(changelog[0].category).toBe("Breaking Changes");
    expect(changelog[0].sources).toContain("pr:15745");

    // The feature change lands under Features with its real grounding.
    const feature = changelog.find((e) => e.category === "Features");
    expect(feature).toBeDefined();
    expect(feature!.sources).toContain("pr:15785");

    // The refactor and fix categories are present (grouping works across types).
    const categories = new Set(changelog.map((e) => e.category));
    expect(categories.has("Refactors")).toBe(true);
    expect(categories.has("Fixes")).toBe(true);
  });

  it("writes internal notes that include the explicit risk level AND its reasons", async () => {
    const { internalReleaseNotes } = await write(
      CHANGE_SET,
      PLAN,
      new MockProvider(),
    );

    // Every section is grounded.
    for (const section of internalReleaseNotes) {
      expect(section.sources.length).toBeGreaterThan(0);
      for (const id of section.sources) expect(VALID_IDS.has(id)).toBe(true);
    }

    const risk = internalReleaseNotes.find((s) => s.heading === "Risk");
    expect(risk).toBeDefined();
    // The risk level is surfaced…
    expect(risk!.body).toContain("HIGH");
    // …and each concrete reason from the plan is reproduced verbatim.
    for (const reason of PLAN.risk.reasons) {
      expect(risk!.body).toContain(reason);
    }

    // Affected systems section reflects the plan's systems.
    const affected = internalReleaseNotes.find(
      (s) => s.heading === "Affected systems",
    );
    expect(affected).toBeDefined();
    expect(affected!.body).toContain("routing");
    expect(affected!.body).toContain("params");
  });

  it("writes customer notes whose BODIES contain no raw ids or PR numbers (but still set sources)", async () => {
    const { customerReleaseNotes } = await write(
      CHANGE_SET,
      PLAN,
      new MockProvider(),
    );

    expect(customerReleaseNotes.length).toBeGreaterThan(0);

    for (const section of customerReleaseNotes) {
      // No internal machinery in the prose a customer reads…
      expect(section.body).not.toMatch(RAW_ID_RE);
      expect(section.body).not.toMatch(PR_NUMBER_RE);
      // (the planted "(#15785)" on the feature summary is scrubbed away).
      expect(section.body).not.toContain("#15785");
      // …but the section is STILL grounded for internal traceability.
      expect(section.sources.length).toBeGreaterThan(0);
      for (const id of section.sources) expect(VALID_IDS.has(id)).toBe(true);
    }

    // The feature's benefit text is present (proves it's the feature content,
    // just without the id), and an action-required section covers the breaking
    // change.
    const allBodies = customerReleaseNotes.map((s) => s.body).join("\n");
    expect(allBodies).toContain("iter_route_contexts");
    expect(
      customerReleaseNotes.some((s) => s.heading === "Action required"),
    ).toBe(true);
  });

  it("is deterministic under MockProvider (same input → deeply-equal output)", async () => {
    const a = await write(CHANGE_SET, PLAN, new MockProvider());
    const b = await write(CHANGE_SET, PLAN, new MockProvider());
    expect(a).toEqual(b);
  });

  it("never emits a section/entry with an unknown (fabricated) source id", async () => {
    const out = await write(CHANGE_SET, PLAN, new MockProvider());
    const allItems = [
      ...out.changelog,
      ...out.internalReleaseNotes,
      ...out.customerReleaseNotes,
    ];
    for (const item of allItems) {
      for (const id of item.sources) {
        expect(VALID_IDS.has(id)).toBe(true);
      }
    }
  });
});
