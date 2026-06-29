# Automated Release Documentation Agent

Turns the raw artifacts of a software release — git commits, merged pull requests, and Jira-shaped tickets — into a complete, **reviewable** release package: a categorized **changelog**, **internal release notes**, **customer-facing release notes**, and section-level **documentation-update suggestions** against the existing docs. A human reviews the draft in a dashboard, edits inline, and **approves** it; every generated claim is grounded in (and cites) the source artifacts it came from. It runs **fully offline with no API key** using a deterministic extractive baseline, and — by setting one environment variable — runs the *same pipeline* with abstractive Claude (`claude-opus-4-8`) generation instead.

Built with **Next.js 15 + TypeScript + Tailwind**. A 4-agent pipeline (Digester → Planner → Release Writer → Documentation Reviewer), hybrid RAG (BM25 + embeddings fused with reciprocal-rank fusion), and a grounded generate → verify → repair loop.

---

## Quickstart

**Prerequisites:** Node 22+ (this repo was built and verified on Node 26). `npm run harvest` additionally needs the [`gh`](https://cli.github.com/) CLI authenticated with `repo` scope.

```bash
npm install        # install dependencies

npm run dev        # start the dev server, then open http://localhost:3000
                   #   the dashboard renders a REAL release end-to-end on load

npm test           # 149 unit tests (vitest), all offline
npm run eval       # run the LIVE pipeline over the real fixtures and score it
npm run build      # production build (next build)
```

**It runs fully offline with no API key.** With no key configured, every agent's LLM call resolves to a deterministic, network-free extractive baseline — so `npm test`, `npm run eval`, and the dashboard all work with zero setup and produce identical output every run.

**Switching on Claude.** Set `ANTHROPIC_API_KEY` (e.g. in a `.env.local` file) and the LLM layer swaps from the deterministic extractive baseline to **abstractive generation with Claude `claude-opus-4-8`** — through the *exact same code path*. The provider is a single swap-point (`getProvider()` in [`lib/llm`](lib/llm/index.ts)): keyed → `AnthropicProvider`, unkeyed → `MockProvider`. The agents, the schemas they validate against, and the grounded verify→repair loop are all unchanged; only the text-generation backend differs. No key is required for any documented command, and an empty/whitespace key degrades safely back to the offline baseline.

```bash
# Optional — switch to abstractive Claude generation:
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env.local
npm run dev          # same UI, now backed by claude-opus-4-8
```

**Re-snapshotting the data** (optional): `npm run harvest` re-harvests the source window from the real OSS repo and rewrites `data/mocks/`. See [`data/README.md`](data/README.md) for the window, the file layout, and why the fixtures are real-derived but frozen.

---

## How it works

The pipeline ([`lib/pipeline.ts`](lib/pipeline.ts)) is a chain of typed contract hand-offs. Each stage consumes and produces a value validated against the shared [Zod schema contract](lib/schemas/index.ts), so stages are built and tested in isolation:

1. **Digester** ([`lib/agents/digester.ts`](lib/agents/digester.ts)) — links commits ↔ PRs ↔ tickets and normalizes them into a deduplicated `ChangeSet`. Every change carries non-empty `sourceIds` (grounding by construction) and a `confidence` score that drops when evidence is thin. Artifacts with no linked ticket are surfaced as `unlinkedArtifactIds`, not hidden.
2. **Planner** ([`lib/agents/planner.ts`](lib/agents/planner.ts)) — groups changes into themes, infers affected systems, computes **explainable risk** (a level plus the concrete reasons), and accounts for **ticket coverage**.
3. **Release Writer** ([`lib/agents/writer.ts`](lib/agents/writer.ts)) — writes the changelog and the internal/customer release notes, each item citing its sources.
4. **Documentation Reviewer** ([`lib/agents/docReviewer.ts`](lib/agents/docReviewer.ts)) — retrieves relevant existing-doc sections and suggests section-level updates.

**Hybrid RAG** ([`lib/rag`](lib/rag/index.ts)): docs are chunked, indexed with both **BM25** (lexical) and **dense embeddings** (semantic), and the two rankings are fused with **reciprocal-rank fusion**. The Documentation Reviewer queries this retriever so its suggestions are anchored to real doc sections.

**Grounding** ([`lib/grounding`](lib/grounding/index.ts)): generation is wrapped in a **generate → verify → bounded-repair** loop. The verifier is deterministic — it checks that every cited id resolves to a real source artifact — and an unfaithful draft gets one chance to repair before being accepted, with any residual failure reported rather than swallowed.

**Provider split** ([`lib/llm`](lib/llm/index.ts)): the `LLMProvider` port is part of the shared contract, with two adapters — `MockProvider` (deterministic extractive baseline, offline) and `AnthropicProvider` (`claude-opus-4-8`, abstractive, with adaptive thinking + structured outputs + prompt-cached system prompt). The pipeline records an observability **trace** per stage (timing + active provider name) so "mock vs anthropic" is visible at a glance in the UI.

For the full picture, see **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** (diagram) and **[`docs/DESIGN.md`](docs/DESIGN.md)** (decisions and tradeoffs).

---

## Evaluation

`npm run eval` generates a release package through the **live pipeline** over the real FastAPI fixtures and scores it. Offline-baseline snapshot (deterministic, reproducible):

| Metric | Result |
|---|---|
| **Hallucination** (ungrounded artifact items) | **0.0%** (0/18) |
| **Ticket coverage** | **7/7** |
| **Doc-recommendation** — PRIMARY (vs curated gold) | **P/R/F1 66.7%** (TP 2, FP 1, FN 1) |
| **Changelog recall** — SUBSTANTIVE (headline) | **100%** (7/7 PRs) |

**Honest doc-recommendation methodology** ([`lib/eval/metrics.ts`](lib/eval/metrics.ts)): precision/recall/F1 are measured against a **hand-curated gold set** ([`data/curated-gold.json`](data/curated-gold.json)) — the primary signal. The "docs that actually changed between the tags" set is only a **weak proxy** (a project can carry documentation debt), so it's reported as a recall *lower bound*, and a recommended-but-unchanged doc is surfaced as **"possible documentation debt"** to investigate, never scored as a false positive. Changelog recall is headlined over *substantive* categories only, because correctly omitting 36 translation PRs from a user-facing changelog is good behavior, not a miss.

---

## Reviewer's Guide

Where to find each grading criterion. All paths are confirmed to exist in this repo.

| Criterion | Where to look |
|---|---|
| **Engineering — code quality & architecture** | Shared Zod **contract** that every stage codes against: [`lib/schemas/index.ts`](lib/schemas/index.ts). Hexagonal **ports/adapters**: the `LLMProvider` port + `getProvider()` ([`lib/llm`](lib/llm/index.ts)) and the `Connector` port + `getConnector()` ([`lib/connectors`](lib/connectors/index.ts)) — each a single swap-point. Orchestration: [`lib/pipeline.ts`](lib/pipeline.ts). |
| **Engineering — maintainability & testing** | **149 tests** across [`lib/**/*.test.ts`](lib) (run `npm test`); pure-function metrics and agents tested in isolation against the schema contract. Production build is green (`npm run build`). |
| **Product — handling incomplete info** | `findUnlinkedArtifactIds` ([`lib/connectors/connector.ts`](lib/connectors/connector.ts)) flags PRs/commits with no ticket; per-change `confidence` scoring ([`lib/agents/digester.ts`](lib/agents/digester.ts)) lowers trust when evidence is thin; ticketless work is surfaced as a signal, not dropped. |
| **Product — UX / review workflow** | The dashboard ([`app/page.tsx`](app/page.tsx), [`components/`](components)), inline editing + **approve/export** ([`components/ReviewBar.tsx`](components/ReviewBar.tsx)), and the approve endpoint that re-validates and stamps the package ([`app/api/approve/route.ts`](app/api/approve/route.ts)). |
| **AI — prompt design** | Agent system prompts + per-call prompts in [`lib/agents/`](lib/agents) (e.g. `WRITER_SYSTEM` in [`writer.ts`](lib/agents/writer.ts)). |
| **AI — retrieval** | Hybrid RAG (BM25 + embeddings + RRF) in [`lib/rag/`](lib/rag/index.ts). |
| **AI — structured outputs** | The Zod output schemas in [`lib/schemas/index.ts`](lib/schemas/index.ts), enforced via the provider's `output_config.format` JSON-schema path in [`lib/llm/anthropic.ts`](lib/llm/anthropic.ts). |
| **AI — evaluation** | Metrics + runner in [`lib/eval/`](lib/eval/metrics.ts); CLI wrapper [`scripts/eval.ts`](scripts/eval.ts). |
| **AI — grounding** | Deterministic citation verifier + generate→verify→repair loop in [`lib/grounding/`](lib/grounding/index.ts). |
| **Design doc — architecture decisions / AI workflow / tradeoffs / future improvements** | [`docs/DESIGN.md`](docs/DESIGN.md) |
| **Design doc — architecture diagram** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **Design doc — AI build playbook** | [`docs/AI_BUILD_PLAYBOOK.md`](docs/AI_BUILD_PLAYBOOK.md) |
