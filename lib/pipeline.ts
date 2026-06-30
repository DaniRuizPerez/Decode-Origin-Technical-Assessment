/**
 * The release-documentation pipeline — the orchestration that turns frozen,
 * real-derived source artifacts into a complete, reviewable `ReleasePackage`.
 *
 * Stages (each a typed contract hand-off):
 *   ingest (connectors) → Digester → Planner → [build RAG index] →
 *   Release Writer ‖ Documentation Reviewer → assemble + annotate.
 *
 * Two coordinator-owned steps live here rather than in any single agent:
 *  - **Observability trace.** Each stage is wall-clock timed and recorded as an
 *    `AgentCallTrace` (with the active provider name), so the UI can show the
 *    pipeline trace and so "mock vs anthropic" is visible at a glance.
 *  - **Doc-debt annotation.** The Documentation Reviewer can't see what the
 *    project actually changed (that would leak eval ground truth into
 *    generation). The pipeline cross-references its suggestions against the
 *    harvested `changedDocPaths`: a recommended doc the project did NOT touch is
 *    flagged `isPossibleDocDebt` — surfaced as a find, never hidden.
 *
 * Offline (no ANTHROPIC_API_KEY) every agent's LLM call resolves to the
 * deterministic extractive baseline, so this whole function is deterministic and
 * network-free. With a key, the same call sites generate abstractively and run
 * the grounded verify→repair loop — no code change.
 */

import { getConnector, loadGroundTruth } from "@/lib/connectors";
import { getProvider } from "@/lib/llm";
import { buildRetriever, chunkDocs } from "@/lib/rag";
import { digest, plan, write, reviewDocs } from "@/lib/agents";
import { buildSourceIndex, buildDocIndex } from "@/lib/sources";
import {
  ReleasePackageSchema,
  type AgentCallTrace,
  type LLMProvider,
  type ReleasePackage,
  type RetrievedChunk,
} from "@/lib/schemas";

export interface PipelineOptions {
  /** Override the provider (defaults to `getProvider()` — Anthropic if keyed, else mock). */
  provider?: LLMProvider;
}

/** Run the full pipeline and return a validated, reviewable release package. */
export async function runPipeline(options: PipelineOptions = {}): Promise<ReleasePackage> {
  const connector = getConnector();
  const provider = options.provider ?? getProvider();

  const input = connector.loadReleaseInput();
  const docs = connector.loadDocs();
  const trace: AgentCallTrace[] = [];

  // Time a stage and record its trace entry. Kept tiny + local so each agent
  // stays a pure function and the trace is owned in one place.
  async function stage<T>(
    agent: string,
    inputSummary: string,
    fn: () => Promise<T>,
    outputSummary: (result: T) => string,
  ): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    trace.push({
      agent,
      provider: provider.name,
      ms: Math.round(performance.now() - t0),
      inputSummary,
      outputSummary: outputSummary(result),
      tokens: null,
    });
    return result;
  }

  // 1. Digest: raw artifacts → grounded ChangeSet.
  const changeSet = await stage(
    "digester",
    `${input.commits.length} commits / ${input.pullRequests.length} PRs / ${input.tickets.length} tickets`,
    () => digest(input, provider),
    (cs) => `${cs.changes.length} changes, ${cs.unlinkedArtifactIds.length} unlinked artifacts`,
  );

  // 2. Plan: themes, affected systems, explainable risk, ticket coverage.
  const releasePlan = await stage(
    "planner",
    `${changeSet.changes.length} changes`,
    () => plan(changeSet, input, provider),
    (p) => `${p.themes.length} themes, risk=${p.risk.level}, coverage ${p.coverage.covered}/${p.coverage.total}`,
  );

  // Build the hybrid retriever over the existing docs (needed by the reviewer).
  const retriever = await buildRetriever(docs);

  // 3 + 4. Generate artifacts. Writer and Documentation Reviewer are independent
  // given the plan, so run them concurrently.
  const [writerOut, docUpdatesRaw] = await Promise.all([
    stage(
      "writer",
      `${changeSet.changes.length} changes, risk=${releasePlan.risk.level}`,
      () => write(changeSet, releasePlan, provider),
      (w) =>
        `${w.changelog.length} changelog entries, ${w.internalReleaseNotes.length}+${w.customerReleaseNotes.length} note sections`,
    ),
    stage(
      "doc-reviewer",
      `${docs.length} existing docs`,
      () => reviewDocs(changeSet, releasePlan, retriever, provider),
      (d) => `${d.length} documentation updates`,
    ),
  ]);

  // Annotate possible documentation debt (coordinator step — see file header).
  const changedDocs = new Set(loadGroundTruth().changedDocPaths);
  const documentationUpdates = docUpdatesRaw.map((d) => ({
    ...d,
    isPossibleDocDebt: !changedDocs.has(d.docPath),
  }));

  // Resolve the DISTINCT ids cited across every artifact into a source index
  // (id → title + GitHub url) so the UI can render readable, clickable evidence
  // instead of opaque ids. Coordinator-owned because it spans all artifact kinds
  // and needs the loaded `input` to resolve titles/urls.
  const citedIds = new Set<string>();
  for (const e of writerOut.changelog) for (const s of e.sources) citedIds.add(s);
  for (const n of writerOut.internalReleaseNotes)
    for (const s of n.sources) citedIds.add(s);
  for (const n of writerOut.customerReleaseNotes)
    for (const s of n.sources) citedIds.add(s);
  for (const d of documentationUpdates) for (const s of d.sources) citedIds.add(s);
  const sourceIndex = buildSourceIndex(input, citedIds);

  // Retrieval evidence for the UI: resolve each suggestion's retrieved chunk by
  // id. Chunk ids are deterministic, so they match the reviewer's references.
  const chunkById = new Map(chunkDocs(docs).map((c) => [c.id, c]));
  const retrieval: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (const d of documentationUpdates) {
    if (!d.retrievedChunkId || seen.has(d.retrievedChunkId)) continue;
    const chunk = chunkById.get(d.retrievedChunkId);
    if (!chunk) continue;
    seen.add(chunk.id);
    retrieval.push({
      id: chunk.id,
      docPath: chunk.docPath,
      section: chunk.section,
      text: chunk.text,
      score: 1,
      signals: {},
    });
  }

  // Resolve the DISTINCT docPaths referenced by the documentation updates and the
  // surfaced retrieval chunks into a doc index (docPath → original repo path +
  // GitHub blob url at the harvested ref), so the UI can link each target doc file
  // to the real doc on GitHub. Parsed from each doc's first-line harvest comment.
  const refPaths = new Set<string>();
  for (const d of documentationUpdates) refPaths.add(d.docPath);
  for (const c of retrieval) refPaths.add(c.docPath);
  const docIndex = buildDocIndex(docs, input.release.project, refPaths);

  // Assemble + validate the package against the shared contract.
  return ReleasePackageSchema.parse({
    release: input.release,
    changeSet,
    plan: releasePlan,
    artifacts: {
      changelog: writerOut.changelog,
      internalReleaseNotes: writerOut.internalReleaseNotes,
      customerReleaseNotes: writerOut.customerReleaseNotes,
      documentationUpdates,
    },
    retrieval,
    sourceIndex,
    docIndex,
    trace,
    approval: { approved: false, approvedAt: null },
  });
}
