# AI Build Playbook

How this project was built using a **multi-agent, loop-engineered workflow** with
Claude Code — and how to reproduce it. This is a methodology document: it complements
[DESIGN.md](./DESIGN.md) (what the system is) by recording *how it was produced*, which
is itself a demonstration of AI-agent engineering.

## The model: one coordinator, many loop-engineered sub-agents

A single **coordinator** (the orchestrating Claude session) owned the architecture and
integration; the **implementation was delegated** to sub-agents, each running in its own
**isolated git worktree**, opening a **pull request** the coordinator reviewed and merged.

```
Coordinator (this session)
 ├─ owns: shared schema contract, data harvest, integration wiring, PR review, merges
 └─ delegates each module to a sub-agent:
        git worktree (isolated)  →  implement + self-verify  →  push branch  →  open PR
        coordinator reviews the diff  →  integrates  →  cleans up the worktree
```

Why this shape:
- **Isolation.** Each sub-agent owns a disjoint directory in its own worktree, so up to
  six ran in parallel with zero file conflicts.
- **Verifiability.** Every sub-agent ran a *loop*, not a one-shot (see below).
- **Reviewability.** Each module is one clean PR with a single-responsibility diff; the
  git history reads as a sequence of reviewed, tested increments.

## Loop engineering: every sub-agent had a backlog + success condition + verify command

Sub-agents were not told "build X." They were given a **backlog** (ordered tasks), a
**success condition per task**, and an exact **verify command**, and instructed to run:

> for each task → implement → run the verify command → green? next : iterate.
> Stop only when the final gate passes or you are genuinely blocked.

The final gate was always concrete and runnable: `npx tsc --noEmit && npx vitest run <dir>`
(or `npm run build` for UI). Each sub-agent reported a per-item checklist, the exact
test counts, the PR URL, and any contract gaps it noticed. This turns "did the agent do
it?" into a machine-checkable question and keeps quality high without micromanagement.

## The waves

Work was sequenced into dependency-ordered waves; the shared contract came first so the
fan-out could proceed in parallel.

| Wave | Owner | What | Result |
|---|---|---|---|
| **0 — Foundation** | Coordinator | Next.js+TS+Tailwind+Vitest scaffold; the **zod schema contract** (the inter-agent protocol); the **data harvester** + a **data-quality acceptance gate** | Foundation on the integration branch |
| **1 — Modules (pilot + 5 parallel)** | Sub-agents | connectors · RAG · LLM provider · grounding · eval · UI shell | PRs #1–#6, merged after review |
| **2 — Pipeline agents (2 parallel)** | Sub-agents | Digester + Planner (understanding); Writer + Documentation Reviewer (generation) | PRs #7–#8, merged after review |
| **3 — Integration** | Coordinator | agent barrel · `pipeline.ts` · `/api/generate` + `/api/approve` · wire UI to real data · wire eval to live pipeline · **end-to-end run** | PR #9 → `main` |
| **4 — Deliverable docs** | Mixed | README + ARCHITECTURE (delegated); DESIGN + this playbook (coordinator) | PRs to `main` |

A **pilot** (the connectors module) was run first, alone, to validate the entire
worktree → install → implement → test → push → PR → integrate loop *before* committing
to a six-way parallel fan-out. The pilot surfaced two real lessons that were then baked
into every subsequent sub-agent brief: (1) worktrees start from an older commit, so each
agent must `git fetch && git merge --ff-only origin/<integration-branch>` first; (2) a
type shared by multiple modules (the `LLMProvider` contract) belongs in the schema
contract, not in one module, so all consumers compile independently.

## Key decisions, made before any code

The plan went through several explicit **critique-and-refine cycles** before execution.
The decisions that shaped the build:
- **Offline-first, swappable LLM** — a deterministic extractive baseline so everything
  runs and is tested with no API key; Anthropic behind the same interface.
- **Real-derived data, validated** — harvest a real OSS release and **evaluate the
  sample against an acceptance gate** (feature mix, linked + unlinked artifacts, doc
  relevance, published ground truth) rather than trust the first window. The first
  harvested window was *rejected* for being feature-poor and ticketless; a wider window
  was chosen and a Jira-shaped ticket layer reconstructed from substantive PRs.
- **Honest evaluation** — treat "docs changed between tags" as a noisy proxy, not gold;
  curate a small primary gold set; surface divergence as "possible doc debt."
- **Grounding in the loop** — generate→verify→repair, not just post-hoc measurement.
- **Scope discipline** — the spec's "Example" section is illustrative, not required, so
  no gold-plating (e.g. no multi-source connectors); cut anything not graded.

## How to reproduce

1. **Establish the contract first.** Author `lib/schemas` (and the provider interface)
   before any module so parallel agents share one stable protocol.
2. **Harvest + gate the data.** `npm run harvest`, then inspect the sample against the
   acceptance criteria; re-pick the window if it's weak.
3. **Pilot one module** end-to-end (worktree → PR → integrate) to validate the loop.
4. **Fan out** the remaining modules as parallel worktree sub-agents, each with a
   backlog + success condition + verify command; review and integrate each PR.
5. **Integrate inline** (pipeline + API + UI + eval) — the cross-cutting seams are not
   parallelizable; do them as the coordinator and run the end-to-end eval.
6. **Document** as PRs, keeping the rationale-heavy docs (DESIGN, this playbook)
   coordinator-authored.

The coordinator additionally kept a **heartbeat** (a ~10-minute cron) as a safety net so
the build advanced even if a background completion notification was missed, and persisted
the working-style + project context to memory for session continuity.

## What this demonstrates

Beyond the product, the build itself exercises: decomposing a system into a stable typed
contract + independently verifiable modules; orchestrating parallel agents with concrete
success criteria; reviewing and integrating machine-generated PRs; and keeping a human in
control of architecture, data quality, and the merge to `main`.
