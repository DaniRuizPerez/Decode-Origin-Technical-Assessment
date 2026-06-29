/**
 * A realistic, schema-valid sample `ReleasePackage`.
 *
 * WHY this file exists: the pipeline (Digester → Planner → Writer → Doc
 * Reviewer) and the `/api/generate` route are built in later waves. Until then
 * the dashboard needs *something* typed and realistic to render so the UI can be
 * developed and reviewed in isolation. The coordinator swaps this for a live
 * fetch from `/api/generate` in Wave 3 — `app/page.tsx` is the single seam.
 *
 * WHY it is real-derived (not invented): every id below is a genuine artifact id
 * from the frozen fixtures of the FastAPI `0.136.0 … 0.137.2` window
 * (`data/mocks/`, see `data/README.md`). The routing-internals refactor is the
 * marquee change of that window (ticket FAPI-1003 / PR #15745), so grounding the
 * sample on it keeps the demo honest: a reviewer can trace any line back to a
 * source id that actually exists in the fixtures.
 *
 * WHY we `.parse()` at module load: the schema is the inter-agent contract. By
 * validating the sample against `ReleasePackageSchema` the moment this module is
 * imported, the sample can never silently drift away from the contract — a typo
 * or a missing required field throws at build/startup, not in the browser.
 */

import { ReleasePackageSchema, type ReleasePackage } from "@/lib/schemas";

/**
 * Raw, un-parsed package literal. Kept as the inferred type (not annotated
 * `ReleasePackage`) so that fields with schema defaults (e.g. `confidence`,
 * `approval`) can be omitted here and filled in by `.parse()` below — exactly
 * how a real pipeline stage would hand its partial output to the next stage.
 */
const RAW = {
  // The release window reference. Mirrors data/mocks/release.json verbatim.
  release: {
    project: "fastapi/fastapi",
    baseRef: "0.136.0",
    headRef: "0.137.2",
    name: "0.137.2",
  },

  /* --------------------------------------------------------------------------
   * Change set — the Digester's normalized, deduplicated, *grounded* changes.
   * Each `sourceIds` entry is a real artifact id from the fixtures.
   * ------------------------------------------------------------------------ */
  changeSet: {
    changes: [
      {
        id: "chg-routing-refactor",
        type: "breaking" as const,
        summary:
          "Refactor internals to preserve APIRouter and APIRoute instances",
        details:
          "include_router no longer flattens sub-routers into the parent: " +
          "router.routes is now a tree of the original APIRouter/APIRoute " +
          "instances rather than a flat list of cloned routes. Code that " +
          "iterated router.routes expecting a flat list must migrate.",
        components: ["routing", "applications"],
        sourceIds: ["ticket:FAPI-1003", "pr:15745", "commit:8e1d774"],
        confidence: 0.95,
        isBreaking: true,
      },
      {
        id: "chg-iter-route-contexts",
        type: "feature" as const,
        summary:
          "Add iter_route_contexts() for advanced use cases that used to read router.routes",
        details:
          "Supported replacement for walking router.routes after the routing " +
          "refactor — yields each route with its accumulated context " +
          "(prefix, tags, dependencies). Motivated by downstream tools such " +
          "as Jupyverse.",
        components: ["routing"],
        sourceIds: ["ticket:FAPI-1006", "pr:15785", "commit:6ac1220"],
        confidence: 0.9,
        isBreaking: false,
      },
      {
        id: "chg-underscore-headers",
        type: "refactor" as const,
        summary:
          "Do not accept underscore headers when using convert_underscores=True (the default)",
        details:
          "Header parameters with underscores are no longer matched when " +
          "convert_underscores is enabled (the default). Clients relying on " +
          "underscore header names must send the hyphenated form.",
        components: ["params", "routing"],
        sourceIds: ["ticket:FAPI-1002", "pr:15589", "commit:063b5bf"],
        confidence: 0.8,
        isBreaking: false,
      },
      {
        id: "chg-empty-path-prefixless",
        type: "fix" as const,
        summary:
          "Allow empty path in path operation in a prefixless router",
        details:
          "Regression follow-up to the routing refactor: an empty path on a " +
          "router with no prefix raised instead of mounting at the parent " +
          "path.",
        components: ["routing"],
        sourceIds: ["ticket:FAPI-1004", "pr:15763", "commit:d8aad20"],
        confidence: 0.85,
        isBreaking: false,
      },
      {
        id: "chg-apiroute-typing",
        type: "fix" as const,
        summary: "Fix typing checks for APIRoute",
        details:
          "Type-checker follow-up to the routing refactor so APIRoute " +
          "subclasses type-check cleanly again.",
        components: ["routing", "typing"],
        sourceIds: ["ticket:FAPI-1005", "pr:15765", "commit:b78c822"],
        confidence: 0.85,
        isBreaking: false,
      },
      {
        id: "chg-sse-validation",
        type: "fix" as const,
        summary:
          "Validate Server-Sent Event fields to avoid sending broken data",
        details:
          "Reject multi-line id/event values in SSE responses, which would " +
          "otherwise corrupt the event stream seen by the client.",
        components: ["responses"],
        sourceIds: ["ticket:FAPI-1001", "pr:15588"],
        confidence: 0.85,
        isBreaking: false,
      },
      {
        id: "chg-pydantic-deprecations",
        type: "deps" as const,
        summary: "Update Pydantic v2 code to address deprecations",
        details:
          "Replace eval_type_lenient and pydantic.color.Color usage flagged " +
          "as deprecated by Pydantic v2.10.",
        components: ["compat"],
        sourceIds: ["ticket:FAPI-1000", "pr:15101"],
        confidence: 0.7,
        isBreaking: false,
      },
      {
        // WHY this change has no ticket: translation/docs PRs in this window are
        // intentionally ticketless in the fixtures, which is what produces the
        // incomplete-information signal below.
        id: "chg-docs-i18n",
        type: "docs" as const,
        summary: "Add and update translations across the documentation",
        details:
          "Batch of community translation PRs with no linked tracking ticket.",
        components: ["docs"],
        sourceIds: ["pr:15760"],
        confidence: 0.6,
        isBreaking: false,
      },
    ],
    // Surfaced in the UI as an incomplete-information signal, not hidden.
    unlinkedArtifactIds: ["pr:15760"],
  },

  /* --------------------------------------------------------------------------
   * Release plan — the Planner's themes, affected systems, explainable risk,
   * and ticket-coverage accounting.
   * ------------------------------------------------------------------------ */
  plan: {
    themes: [
      {
        title: "Routing internals overhaul",
        summary:
          "APIRouter/APIRoute instances are now preserved in a route tree, " +
          "with a supported iteration API and two follow-up fixes.",
        changeIds: [
          "chg-routing-refactor",
          "chg-iter-route-contexts",
          "chg-empty-path-prefixless",
          "chg-apiroute-typing",
        ],
      },
      {
        title: "Request/response correctness",
        summary:
          "Stricter header handling and SSE field validation tighten how " +
          "FastAPI handles untrusted input.",
        changeIds: ["chg-underscore-headers", "chg-sse-validation"],
      },
      {
        title: "Dependency hygiene",
        summary: "Clear Pydantic v2 deprecations ahead of upstream removal.",
        changeIds: ["chg-pydantic-deprecations"],
      },
    ],
    affectedSystems: ["routing", "params", "responses", "compat", "docs"],
    // Explainable risk: HIGH, with the concrete reasons that produced it.
    risk: {
      level: "high" as const,
      reasons: [
        "Breaking change to include_router / router.routes semantics (PR #15745) affects a core, widely-used API.",
        "Two regression fixes (#15763, #15765) landed in the same window, indicating the refactor shipped with rough edges.",
        "Default header-handling change (#15589) can silently break clients that rely on underscore header names.",
      ],
    },
    // Missing-ticket-coverage accounting (one of the spec's eval metrics).
    coverage: {
      total: 8,
      covered: 7,
      missingTicketKeys: ["pr:15760"],
    },
  },

  /* --------------------------------------------------------------------------
   * Generated artifacts — Release Writer + Documentation Reviewer output.
   * Every line carries `sources`, so the UI can make each claim traceable.
   * ------------------------------------------------------------------------ */
  artifacts: {
    changelog: [
      {
        category: "Breaking Changes",
        text:
          "include_router now preserves the original APIRouter and APIRoute " +
          "instances; router.routes is a tree rather than a flat list of " +
          "clones. Migrate code that iterates router.routes.",
        sources: ["ticket:FAPI-1003", "pr:15745", "commit:8e1d774"],
      },
      {
        category: "Features",
        text:
          "Added iter_route_contexts() as the supported way to walk routes " +
          "with their accumulated context after the routing refactor.",
        sources: ["ticket:FAPI-1006", "pr:15785", "commit:6ac1220"],
      },
      {
        category: "Fixes",
        text:
          "Fixed an empty path on a prefixless router and corrected APIRoute " +
          "typing checks — both follow-ups to the routing refactor.",
        sources: ["pr:15763", "pr:15765", "commit:d8aad20", "commit:b78c822"],
      },
      {
        category: "Fixes",
        text:
          "Server-Sent Event id/event fields are now validated to reject " +
          "multi-line values that would corrupt the stream.",
        sources: ["ticket:FAPI-1001", "pr:15588"],
      },
      {
        category: "Refactors",
        text:
          "Underscore header names are no longer accepted when " +
          "convert_underscores is enabled (the default).",
        sources: ["ticket:FAPI-1002", "pr:15589", "commit:063b5bf"],
      },
      {
        category: "Upgrades",
        text: "Updated Pydantic v2 usage to clear deprecation warnings.",
        sources: ["ticket:FAPI-1000", "pr:15101"],
      },
    ],
    internalReleaseNotes: [
      {
        heading: "Risk & rollout",
        body:
          "HIGH risk. The routing-internals refactor (#15745) changes a core " +
          "API and already required two follow-up fixes (#15763, #15765) in " +
          "this window. Roll out behind a canary and watch for integrations " +
          "that iterate router.routes directly.",
        sources: ["pr:15745", "pr:15763", "pr:15765"],
      },
      {
        heading: "Migration notes for maintainers",
        body:
          "Replace direct router.routes traversal with iter_route_contexts(). " +
          "Audit internal tooling and tests that assumed a flat, cloned route " +
          "list.",
        sources: ["ticket:FAPI-1006", "pr:15785"],
      },
      {
        heading: "Incomplete information",
        body:
          "One PR (#15760, translations) has no linked ticket, so its intent " +
          "is unverified. Coverage is 7/8 substantive changes.",
        sources: ["pr:15760"],
      },
    ],
    customerReleaseNotes: [
      {
        heading: "What's new",
        body:
          "A new iter_route_contexts() helper makes it easier to inspect your " +
          "application's routes together with their prefixes, tags, and " +
          "dependencies.",
        sources: ["ticket:FAPI-1006", "pr:15785"],
      },
      {
        heading: "Action required",
        body:
          "If your code reads app.router.routes or passes underscore header " +
          "names, please review the migration guide: routes are now nested " +
          "and underscore headers are rejected by default.",
        sources: ["pr:15745", "pr:15589"],
      },
      {
        heading: "Reliability",
        body:
          "Server-Sent Event responses now reject malformed field values, " +
          "preventing a class of broken event streams.",
        sources: ["ticket:FAPI-1001", "pr:15588"],
      },
    ],
    documentationUpdates: [
      {
        // Real doc + real grounding from data/curated-gold.json.
        docPath: "tutorial__bigger-applications.md",
        section: "Include the same router multiple times with different prefix",
        suggestion:
          "Update the include_router explanation and examples: router.routes " +
          "is now a tree of preserved APIRouter/APIRoute instances, not a " +
          "flat list of clones.",
        retrievedChunkId: "chunk:bigger-applications#include-router",
        sources: ["ticket:FAPI-1003", "pr:15745"],
        isPossibleDocDebt: false,
      },
      {
        docPath: "tutorial__header-params.md",
        section: "Automatic conversion",
        suggestion:
          "Document that underscore header names are no longer accepted when " +
          "convert_underscores is True (the default); show the hyphenated " +
          "form instead.",
        retrievedChunkId: "chunk:header-params#automatic-conversion",
        sources: ["ticket:FAPI-1002", "pr:15589"],
        isPossibleDocDebt: false,
      },
      {
        // WHY flagged as possible doc debt: this advanced doc demonstrates
        // iterating router.routes directly but was NOT touched in the release,
        // so we recommend (not assert) an update. changed-docs is a noisy
        // proxy, not ground truth (see schema DESIGN comment).
        docPath: "advanced__openapi-callbacks.md",
        section: "Create the callback path operations",
        suggestion:
          "The example iterates router.routes directly; migrate it to " +
          "iter_route_contexts() so it keeps working after the routing " +
          "refactor.",
        retrievedChunkId: "chunk:openapi-callbacks#callback-routes",
        sources: ["ticket:FAPI-1006", "pr:15785"],
        isPossibleDocDebt: true,
      },
    ],
  },

  /* --------------------------------------------------------------------------
   * Retrieval evidence (RAG) backing the documentation suggestions. The UI can
   * resolve a DocUpdate.retrievedChunkId to one of these to show the grounding.
   * ------------------------------------------------------------------------ */
  retrieval: [
    {
      id: "chunk:bigger-applications#include-router",
      docPath: "tutorial__bigger-applications.md",
      section: "Include the same router multiple times with different prefix",
      text:
        "You can use .include_router() multiple times with the same router " +
        "using different prefixes. This could be useful, for example, to " +
        "expose the same API under different prefixes.",
      score: 0.82,
      signals: { bm25: 0.61, dense: 0.74 },
    },
    {
      id: "chunk:header-params#automatic-conversion",
      docPath: "tutorial__header-params.md",
      section: "Automatic conversion",
      text:
        "Header parameters are automatically converted: underscores are " +
        "treated as hyphens and matching is case-insensitive. You can disable " +
        "this with convert_underscores=False.",
      score: 0.78,
      signals: { bm25: 0.7, dense: 0.66 },
    },
    {
      id: "chunk:openapi-callbacks#callback-routes",
      docPath: "advanced__openapi-callbacks.md",
      section: "Create the callback path operations",
      text:
        "Use a regular APIRouter for the callbacks and then iterate over its " +
        "routes to build the OpenAPI callback object.",
      score: 0.69,
      signals: { bm25: 0.55, dense: 0.6 },
    },
  ],

  /* --------------------------------------------------------------------------
   * Observability trace — one record per agent/LLM call. Powers the UI's
   * collapsible "pipeline trace" view. provider="mock" because no LLM is wired.
   * ------------------------------------------------------------------------ */
  trace: [
    {
      agent: "digester",
      provider: "mock",
      ms: 142,
      inputSummary:
        "250 commits, 158 PRs, 7 tickets from fastapi/fastapi 0.136.0..0.137.2",
      outputSummary: "8 normalized changes; 1 unlinked PR (#15760)",
      tokens: null,
    },
    {
      agent: "planner",
      provider: "mock",
      ms: 88,
      inputSummary: "8 changes",
      outputSummary:
        "3 themes; risk=high (3 reasons); coverage 7/8",
      tokens: null,
    },
    {
      agent: "retriever",
      provider: "mock",
      ms: 53,
      inputSummary: "8 changes vs 60 doc chunks (hybrid BM25 + dense)",
      outputSummary: "3 chunks retrieved for doc suggestions",
      tokens: null,
    },
    {
      agent: "writer",
      provider: "mock",
      ms: 205,
      inputSummary: "8 changes, 3 themes",
      outputSummary:
        "6 changelog entries, 3 internal + 3 customer note sections",
      tokens: { input: 1840, output: 612 },
    },
    {
      agent: "doc-reviewer",
      provider: "mock",
      ms: 121,
      inputSummary: "3 retrieved chunks + 8 changes",
      outputSummary: "3 doc updates (1 possible doc debt)",
      tokens: { input: 980, output: 270 },
    },
  ],

  // Not yet approved — the Review bar drives this client-side in the dashboard.
  approval: { approved: false, approvedAt: null },
};

/**
 * The exported sample. `.parse()` strips unknowns, applies defaults, and — most
 * importantly — throws at import time if `RAW` ever violates the contract, so a
 * broken sample fails the build instead of shipping to the browser.
 */
export const SAMPLE_PACKAGE: ReleasePackage = ReleasePackageSchema.parse(RAW);
