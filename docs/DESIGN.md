# Design Document — Automated Release Documentation Agent

A concise design rationale for the system. For the end-to-end diagram and component
map see [ARCHITECTURE.md](./ARCHITECTURE.md); for how the project was built with a
multi-agent workflow see [AI_BUILD_PLAYBOOK.md](./AI_BUILD_PLAYBOOK.md).

## Contents
- [Context](#context)
- [Assumptions & open questions](#assumptions--open-questions)
- [Architecture decisions](#architecture-decisions)
- [AI workflow](#ai-workflow)
- [Tradeoffs made](#tradeoffs-made)
- [Future improvements](#future-improvements)

## Context

The system turns engineering artifacts (git commits, pull requests, Jira-shaped
tickets, existing documentation) into four release artifacts — a **changelog**,
**internal release notes**, **customer release notes**, and **documentation-update
suggestions** — and presents them in a review/edit/approve UI. The hard problem is
not generating text; it is generating text a team can *trust*: every claim must be
traceable to a source, the system must behave sensibly on messy/incomplete inputs,
and its quality must be *measurable*. Those three concerns drove every decision below.

## Assumptions & open questions

The spec defines the *outputs* but leaves the *inputs and rules* open. We surfaced
the gaps and resolved them deliberately (a deliberate-assumption list is itself part
of "handling incomplete information"):

1. **What is a "release"?** Undefined → we define it as the commits/PRs/tickets
   between two git tags.
2. **Artifact linkage is partial.** Real PRs/commits don't always reference a ticket.
   We infer links by reference and **surface unlinked artifacts** rather than hide them.
3. **No input schema is given** → we define one (Jira-shaped tickets, GitHub-shaped
   commits/PRs, markdown docs) in `lib/schemas`.
4. **Doc-suggestion granularity** → section-level ("add an SSO section to X"),
   matching the PDF's example, not literal diffs.
5. **Conflicting sources** → code (PR/commit) is treated as source-of-truth over a
   ticket's stated intent; conflicts are surfaced.
6. **Risk rubric** → Low/Medium/High with stated, auditable criteria (not a vibe).
7. **Approval semantics** → approval finalizes an immutable, exported package
   (spec-shape JSON); one release per run; stateless; no live publishing target.
8. **Scale / i18n / multi-source** → out of scope; noted under Future improvements.

## Architecture decisions

**Hexagonal (ports & adapters).** The core (agents + pipeline) depends only on
interfaces — `Connector`, `LLMProvider`, `EmbeddingProvider` — never on concrete I/O.
Adapters (`MockConnector`; `MockProvider`/`AnthropicProvider`; hashing/optional-neural
embeddings) plug in at the edges. This is what makes the system both **offline-first
and key-ready with no code change**, and trivially testable.

**The schema contract is the inter-agent protocol.** `lib/schemas/index.ts` is the
single source of truth: every pipeline stage consumes and produces a zod-validated
value, so stages were built and tested in isolation by independent sub-agents. The
contract also encodes the **grounding guarantee** at the type level — a `Change`
cannot exist without ≥1 `sourceId`, and every generated artifact item carries
`sources[]`. "Every claim is traceable" is therefore a compile-time invariant, not a
hope.

**Offline-first with a swappable provider — and a *principled* mock.** The default
provider is a **deterministic extractive baseline**: each agent computes a grounded,
schema-valid output from the real inputs (grouping/surfacing real PRs/tickets with
their real citations) and passes it as a `fallback`. Offline, that fallback *is* the
output — grounded by construction (hallucination ≈ 0). With `ANTHROPIC_API_KEY` set,
the same call sites generate abstractively with `claude-opus-4-8`. The mock is thus
the *floor the LLM must beat* and an always-available fallback — not a throwaway stub.

**Hybrid Digester.** Normalizing raw artifacts into a `ChangeSet` is mostly
deterministic (parse, classify by labels/paths, infer components, collapse noise),
with the LLM used only for enrichment. This shrinks the hallucination surface and the
cost, and keeps the change set honest.

**Real-derived, frozen mock data.** Rather than a fixture tuned to look good, we
harvested a real FastAPI window (`0.136.0…0.137.2`) into `data/mocks/` and run on it.
It is messy on purpose — 158 PRs of which only 7 are substantive (a routing breaking
change, a feature, fixes, refactors, an upgrade), the rest translations/internal noise
— which is exactly what stresses signal extraction and incomplete-info handling.

**Next.js 15 + TypeScript + Tailwind**, the suggested stack, with a server component
that runs the pipeline at request time and a client dashboard for review/approve.

## AI workflow

**A four-agent pipeline** (the spec's suggested shape), each a typed, pure function:
**Digester** (raw artifacts → grounded `ChangeSet`) → **Planner** (themes, affected
systems, explainable risk, ticket coverage) → **Release Writer** (changelog +
internal/customer notes) ‖ **Documentation Reviewer** (retrieval-driven doc-update
suggestions). The pipeline orchestrates them and times each stage into an observability
**trace**.

**Grounding fought *in the loop*, not just measured.** The Writer and Documentation
Reviewer run inside a **generate → verify → repair** loop (`lib/grounding`): the
verifier checks every generated item's `sources[]` against the set of real artifact
ids; unsupported items trigger one bounded repair pass (regenerate citing only valid
ids, or drop the claim). The verifier is **deterministic in both modes** — it checks
that every cited id resolves to a real source artifact (citation existence). Offline
the mock returns the already-grounded fallback, so the loop is a no-op pass; **when
keyed, abstractive generation can introduce ungrounded claims and the same loop
catches and repairs them**. A *semantic* LLM claim-verifier (does the cited text
actually support the claim?) reuses the same report shape and is a documented future
extension — see Future improvements. Hallucination is attacked at generation time,
not just on a scoreboard.

**Structured outputs as a hard contract.** Each LLM call uses zod schemas; the
Anthropic provider sends `output_config.format` derived from `z.toJSONSchema(schema)`
(zod v4) and re-validates the response with `schema.parse`, so malformed output can't
propagate. The typed I/O between agents is the same idea applied to the whole pipeline.

**Retrieval strategy.** Docs are chunked by heading; retrieval fuses **BM25** (lexical)
and **dense embeddings** via **Reciprocal Rank Fusion**. Hybrid matters here because
release queries are short and entity-heavy (`include_router`, `convert_underscores`):
lexical pins exact identifiers. The *default* dense embeddings are dependency-free
FNV-1a hashing — also lexical (token-hash bag), **not** semantic — so the offline
fusion is two complementary lexical views, and paraphrase recall is *not* captured by
default. Capturing paraphrase is the env-gated neural upgrade (`RAG_EMBEDDINGS=transformers`,
a MiniLM model); the offline tradeoff is detailed under Tradeoffs. The Documentation
Reviewer queries with a change's summary **plus its code identifiers** to land on the
right doc.

**Context engineering + cost.** Each agent receives only typed inputs and retrieved
chunks (small prompts); the Anthropic provider prompt-caches the stable system block
across calls. Prompts are first-class, versioned artifacts colocated with each agent,
with explicit grounding rules ("state only what the sources support; if unknown, say
so").

**Evaluation as a first-class, honest harness** (`lib/eval`, `npm run eval`): it runs
the live pipeline and scores it on **hallucination rate**, **missing-ticket coverage**,
**doc-recommendation accuracy**, and **changelog recall** (the spec's three metrics
plus a clean bonus). Determinism (no sampling params; frozen fixtures; the deterministic
baseline) makes the evals reproducible — a property most LLM demos lack — which in turn
enables eval-driven prompt iteration once a key is present.

Verified offline baseline on the real data: hallucination **0.0%**, ticket coverage
**7/7**, doc-rec vs curated gold **P/R/F1 66.7%**, changelog **substantive recall 100%**.

## Tradeoffs made

- **Extractive baseline vs abstractive quality.** Offline output is grounded but
  terse/templated; the LLM adds fluency and synthesis at the cost of a grounding *risk*
  we then manage with the verify→repair loop. We made the floor safe and the ceiling
  optional.
- **Mocked ingestion vs live APIs.** We freeze real-derived data for reproducibility
  and zero-network runs (the spec permits mocks); the connector interface keeps live
  GitHub/Jira a drop-in, but we explicitly do **not** productionize it.
- **Reconstructed tickets.** FastAPI PRs don't link Jira, so tickets are reconstructed
  (Jira-shaped) from substantive PRs and documented as such. This honors the "Jira"
  source on real data; the cost is that linkage is cleaner than a messy real Jira.
- **Doc-recommendation ground truth is noisy.** "Docs changed between tags" is a *weak
  proxy* (projects carry doc debt), so it is used only as a recall lower bound; the
  primary signal is a small hand-curated gold set (single-annotator — a stated
  limitation). A recommended doc the project didn't touch is surfaced as **possible doc
  debt**, never auto-counted as a false positive.
- **Deterministic embeddings by default.** A dependency-free hashing embedding keeps
  the build robust and offline-reproducible (and avoids fragile native deps on Node 26);
  a real transformer model is an env-gated upgrade. The tradeoff is weaker semantic
  recall offline — visible as the one doc-rec false negative (`openapi-callbacks.md`).
- **Wide release window.** FastAPI ships tiny releases, so we aggregate six into one
  "release" for a realistic mix — at the cost of a longer-than-typical window.
- **Per-request pipeline render.** Simple and correct offline; for keyed use it would
  want a "generate" action + caching rather than running Claude on every page load.
- **Diffs are shown honestly, not fabricated.** Changelog per-file diffs are the *real*
  unified-diff patches harvested from GitHub, capped for snapshot size (no patch for
  >20-file PRs or single patches >8 KB — those degrade to a path + line counts + a
  GitHub link). The doc "suggested edit" is a before→after diff whose offline form weaves
  the change's description into the section as documentation prose (a heuristic addition,
  not a full rewrite); the fuller integrated rewrite is the keyed (`proposedText`) path. The diff itself is
  UI-only and not scored by the evaluator.

## Future improvements

- **Neural embeddings + a cross-encoder reranker** for stronger doc retrieval.
  *Validated:* a session-run of the abstractive pipeline (see `data/samples/`) lifted
  doc-rec **precision 66.7% → 100%** (F1 → 80%) by reasoning away irrelevant picks, but
  left the one recall miss (`openapi-callbacks.md`) — which isn't retrieved even at
  k=8 — confirming that *retrieval*, not generation, is the bottleneck for that doc.
- **LLM-judge faithfulness at scale** — turn on the keyed claim-verifier as the
  headline hallucination metric, ideally with a different judge model to reduce bias.
- **Multi-source connectors** (Slack, Linear, Zendesk, Confluence, Google Docs) behind
  the existing `Connector` port — the bonus the spec hints at.
- **Theme-level doc retrieval** (query per theme, not per change) and a component-alias
  map so e.g. `dependencies/utils.py` themes under "Headers", not "Dependencies".
- **Eval-driven CI gate** — fail a PR if hallucination rises or coverage/recall drops
  against the committed ground truth.
- **Larger, multi-annotator curated gold** and a held-out release for generalization.
- **Streaming + caching** for keyed runs; a "regenerate"/diff-against-previous-release
  workflow; persistence of approved packages.
