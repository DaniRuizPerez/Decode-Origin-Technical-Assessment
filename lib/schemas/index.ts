/**
 * Shared schema contract — the single source of truth for the whole pipeline.
 *
 * Every agent and module codes against these zod schemas. Two reasons this file
 * is the backbone of the architecture:
 *
 *  1. **Typed contracts between agents.** Each pipeline stage (Digester →
 *     Planner → Writer → Documentation Reviewer) consumes and produces a value
 *     validated against a schema here. The schema *is* the inter-agent protocol,
 *     so stages can be built and tested in isolation.
 *  2. **Grounding by construction.** Generated artifacts are required to carry
 *     `sources[]` (ids of the commits / PRs / tickets that justify them). The
 *     faithfulness verifier and the hallucination metric both rely on this, so
 *     "every claim is traceable to evidence" is enforced at the type level.
 *
 * Naming: every source artifact has a stable, namespaced `id`
 * (`commit:<sha>`, `pr:<number>`, `ticket:<key>`). Citations everywhere are just
 * arrays of these ids, which keeps evidence linking uniform and cheap to verify.
 */

import { z } from "zod";

/* ============================================================================
 * 1. SOURCE ARTIFACTS (mock connectors serve these from data/mocks/)
 *
 * Real-derived but frozen: harvested once from a real OSS release window and
 * committed as JSON. The runtime only ever reads local files — never the network.
 * ========================================================================== */

/** A git commit in the release window. */
export const CommitSchema = z.object({
  /** Canonical artifact id, e.g. "commit:1a2b3c4". */
  id: z.string(),
  sha: z.string(),
  message: z.string(),
  author: z.string(),
  /** ISO-8601 timestamp. */
  date: z.string(),
  /** Changed file paths — used to infer affected components and risk signals. */
  files: z.array(z.string()).default([]),
  /** PR numbers referenced by this commit (inferred during linkage). */
  prNumbers: z.array(z.number()).default([]),
  /** Ticket keys referenced in the commit message (inferred during linkage). */
  ticketKeys: z.array(z.string()).default([]),
});
export type Commit = z.infer<typeof CommitSchema>;

/** A merged pull request in the release window. */
export const PullRequestSchema = z.object({
  /** Canonical artifact id, e.g. "pr:1234". */
  id: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string().default(""),
  author: z.string(),
  /** ISO-8601 timestamp, or null if not merged. */
  mergedAt: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  commitShas: z.array(z.string()).default([]),
  /** Ticket keys referenced by this PR (inferred during linkage). */
  ticketKeys: z.array(z.string()).default([]),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

/**
 * A **Jira-shaped** ticket. The assessment lists "Jira tickets" as a source; we
 * model the canonical ticket type on Jira's fields and map real GitHub Issues
 * onto it during harvest (documented in the connector). This honors the spec on
 * real data without a live Jira integration.
 */
export const TicketSchema = z.object({
  /** Canonical artifact id, e.g. "ticket:PROJ-123". */
  id: z.string(),
  /** Human key, e.g. "PROJ-123" (Jira) or "GH-123" (mapped issue). */
  key: z.string(),
  summary: z.string(),
  description: z.string().default(""),
  issueType: z
    .enum(["story", "bug", "task", "epic", "improvement"])
    .default("task"),
  status: z.string().default("Done"),
  components: z.array(z.string()).default([]),
  fixVersions: z.array(z.string()).default([]),
  /** PR numbers that close/implement this ticket (inferred during linkage). */
  prNumbers: z.array(z.number()).default([]),
});
export type Ticket = z.infer<typeof TicketSchema>;

/** Identifies the release window the artifacts belong to. */
export const ReleaseRefSchema = z.object({
  project: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  /** Display name, e.g. "0.111.0". */
  name: z.string().optional(),
});
export type ReleaseRef = z.infer<typeof ReleaseRefSchema>;

/** The full bundle of source artifacts for one release (docs handled by RAG). */
export const ReleaseInputSchema = z.object({
  release: ReleaseRefSchema,
  commits: z.array(CommitSchema),
  pullRequests: z.array(PullRequestSchema),
  tickets: z.array(TicketSchema),
});
export type ReleaseInput = z.infer<typeof ReleaseInputSchema>;

/* ============================================================================
 * 2. CHANGE SET (Digester output)
 *
 * Normalized, deduplicated changes. Each change is grounded: `sourceIds` is
 * required and non-empty, so a change can never exist without provenance.
 * ========================================================================== */

export const ChangeTypeSchema = z.enum([
  "feature",
  "fix",
  "docs",
  "refactor",
  "perf",
  "test",
  "chore",
  "breaking",
  "security",
  "deps",
]);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

export const ChangeSchema = z.object({
  id: z.string(),
  type: ChangeTypeSchema,
  /** One-line human summary. */
  summary: z.string(),
  details: z.string().default(""),
  /** Affected components/areas (inferred from changed file paths). */
  components: z.array(z.string()).default([]),
  /**
   * Provenance: ids of the commits / PRs / tickets this change is derived from.
   * Required and non-empty — the grounding guarantee.
   */
  sourceIds: z.array(z.string()).min(1),
  /** Lower when the underlying evidence is thin (e.g. terse PR, no ticket). */
  confidence: z.number().min(0).max(1).default(1),
  isBreaking: z.boolean().default(false),
});
export type Change = z.infer<typeof ChangeSchema>;

export const ChangeSetSchema = z.object({
  changes: z.array(ChangeSchema),
  /**
   * Artifact ids with no linked ticket (PRs/commits we couldn't tie to intent).
   * Surfaced in the UI as an incomplete-information signal rather than hidden.
   */
  unlinkedArtifactIds: z.array(z.string()).default([]),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/* ============================================================================
 * 3. RELEASE PLAN (Planner output)
 * ========================================================================== */

/** Explainable risk: a level plus the concrete reasons that produced it. */
export const RiskSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
});
export type Risk = z.infer<typeof RiskSchema>;

export const ThemeSchema = z.object({
  title: z.string(),
  summary: z.string(),
  /** Ids of the changes grouped under this theme. */
  changeIds: z.array(z.string()),
});
export type Theme = z.infer<typeof ThemeSchema>;

/** Missing-ticket-coverage accounting (one of the spec's eval metrics). */
export const TicketCoverageSchema = z.object({
  total: z.number(),
  covered: z.number(),
  missingTicketKeys: z.array(z.string()),
});
export type TicketCoverage = z.infer<typeof TicketCoverageSchema>;

export const ReleasePlanSchema = z.object({
  themes: z.array(ThemeSchema),
  affectedSystems: z.array(z.string()),
  risk: RiskSchema,
  coverage: TicketCoverageSchema,
});
export type ReleasePlan = z.infer<typeof ReleasePlanSchema>;

/* ============================================================================
 * 4. RETRIEVAL (RAG output — consumed by the Documentation Reviewer)
 * ========================================================================== */

/** A retrieved documentation chunk with its hybrid-retrieval scores. */
export const RetrievedChunkSchema = z.object({
  id: z.string(),
  docPath: z.string(),
  /** Nearest heading — the "section" a suggestion would target. */
  section: z.string(),
  text: z.string(),
  /** Fused score (reciprocal-rank fusion of the signals below). */
  score: z.number(),
  signals: z
    .object({ bm25: z.number().optional(), dense: z.number().optional() })
    .default({}),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

/* ============================================================================
 * 5. GENERATED ARTIFACTS (Release Writer + Documentation Reviewer output)
 *
 * Internal types are richer than the spec's suggested output (they carry
 * citations per item); `toSpecOutput` (lib/export) renders them to the exact
 * snake_case shape the PDF suggests.
 * ========================================================================== */

export const ChangelogEntrySchema = z.object({
  /** Conventional grouping, e.g. "Features", "Fixes", "Docs". */
  category: z.string(),
  text: z.string(),
  sources: z.array(z.string()),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;

/** A section of release notes, grounded by `sources`. */
export const NoteSectionSchema = z.object({
  heading: z.string(),
  body: z.string(),
  sources: z.array(z.string()).default([]),
});
export type NoteSection = z.infer<typeof NoteSectionSchema>;

/** A suggestion to update an existing doc (section-level, per the PDF example). */
export const DocUpdateSchema = z.object({
  docPath: z.string(),
  section: z.string(),
  suggestion: z.string(),
  /** The retrieved chunk that grounds this suggestion, if any. */
  retrievedChunkId: z.string().nullable().default(null),
  sources: z.array(z.string()).default([]),
  /**
   * True when we recommend updating a doc the project did NOT touch in this
   * release — surfaced as "possible documentation debt" rather than an error.
   * (See DESIGN: changed-docs is a noisy proxy, not ground truth.)
   */
  isPossibleDocDebt: z.boolean().default(false),
});
export type DocUpdate = z.infer<typeof DocUpdateSchema>;

export const ReleaseArtifactsSchema = z.object({
  changelog: z.array(ChangelogEntrySchema),
  internalReleaseNotes: z.array(NoteSectionSchema),
  customerReleaseNotes: z.array(NoteSectionSchema),
  documentationUpdates: z.array(DocUpdateSchema),
});
export type ReleaseArtifacts = z.infer<typeof ReleaseArtifactsSchema>;

/* ============================================================================
 * 6. OBSERVABILITY + PACKAGE (pipeline output)
 * ========================================================================== */

/** One LLM call's trace record — powers the UI "pipeline trace" view. */
export const AgentCallTraceSchema = z.object({
  agent: z.string(),
  provider: z.string(), // "mock" | "anthropic"
  ms: z.number(),
  inputSummary: z.string(),
  outputSummary: z.string(),
  tokens: z
    .object({ input: z.number(), output: z.number() })
    .nullable()
    .default(null),
});
export type AgentCallTrace = z.infer<typeof AgentCallTraceSchema>;

export const ApprovalSchema = z.object({
  approved: z.boolean().default(false),
  approvedAt: z.string().nullable().default(null),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/** The complete, reviewable output of one pipeline run. */
export const ReleasePackageSchema = z.object({
  release: ReleaseRefSchema,
  changeSet: ChangeSetSchema,
  plan: ReleasePlanSchema,
  artifacts: ReleaseArtifactsSchema,
  /** Retrieval evidence surfaced for the documentation suggestions. */
  retrieval: z.array(RetrievedChunkSchema).default([]),
  trace: z.array(AgentCallTraceSchema).default([]),
  approval: ApprovalSchema.default({ approved: false, approvedAt: null }),
});
export type ReleasePackage = z.infer<typeof ReleasePackageSchema>;

/* ============================================================================
 * 7. GROUND TRUTH (produced by the harvest script; consumed by the eval suite)
 * ========================================================================== */

/**
 * Auto-generated reference signals for evaluation, derived from the project's own
 * history by the harvest script — NOT authored by us. See lib/eval and DESIGN for
 * how each is used (and why `changedDocPaths` is a weak proxy, not gold).
 */
export const GroundTruthSchema = z.object({
  release: ReleaseRefSchema,
  /** PR numbers listed across the window's published release notes. */
  releaseNotePrNumbers: z.array(z.number()).default([]),
  /**
   * PR number (as a string key) → release-notes category ("Features", "Fixes",
   * "Translations", "Internal", …). Lets the eval measure changelog recall over
   * *substantive* categories and credit correct exclusion of noise, rather than
   * penalizing the system for not changelogging 36 translation PRs.
   */
  releaseNotePrCategories: z.record(z.string(), z.string()).default({}),
  /** Doc files that actually changed between the tags (weak proxy — see DESIGN). */
  changedDocPaths: z.array(z.string()).default([]),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

/**
 * Hand-curated gold set (data/curated-gold.json) — the *primary* doc-recommendation
 * reference. Real inputs, human-judged labels. Kept in a separate file so
 * re-harvesting (which regenerates data/mocks/) never clobbers it. Single-annotator;
 * this limitation is documented in DESIGN. `changedDocPaths` above is the secondary,
 * noisier signal precisely because the project may carry documentation debt.
 */
export const CuratedGoldSchema = z.object({
  release: ReleaseRefSchema,
  impactedDocs: z.array(
    z.object({
      docPath: z.string(),
      /** Why this doc should change, tied to the responsible change(s). */
      rationale: z.string(),
    }),
  ),
});
export type CuratedGold = z.infer<typeof CuratedGoldSchema>;

/* ============================================================================
 * 8. PROVIDER CONTRACT (the AI boundary)
 *
 * The LLM provider interface lives in the shared contract (not in lib/llm) so
 * every consumer — the agents and the grounding loop — depends on the same
 * boundary type and can be built and tested independently of the concrete
 * implementation. Implemented in lib/llm as MockProvider / AnthropicProvider.
 * ========================================================================== */

/**
 * One structured-generation request. The calling agent supplies a deterministic,
 * grounded `fallback` (its extractive-baseline output); the offline MockProvider
 * returns that fallback, while the AnthropicProvider ignores it and generates
 * abstractively. Either way the result is validated against `schema`.
 */
export interface CompletionRequest<T> {
  /** Stage name, for the observability trace (e.g. "writer", "doc-reviewer"). */
  agent: string;
  system: string;
  prompt: string;
  /** Output schema; the returned value is parsed/validated against it. */
  schema: z.ZodType<T>;
  /** Deterministic grounded fallback, returned when no LLM is configured. */
  fallback: T;
}

export interface CompletionResult<T> {
  value: T;
  trace: AgentCallTrace;
}

/** The swappable AI boundary. `name` is "mock" | "anthropic". */
export interface LLMProvider {
  readonly name: string;
  complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>>;
}
