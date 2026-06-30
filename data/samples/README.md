# Sample release packages — baseline vs. abstractive

Two full `ReleasePackage` outputs for the **same input** (the harvested FastAPI
`0.136.0…0.137.2` window), so a reviewer can see the system's output without running
it, and compare the deterministic baseline against abstractive generation. Score
either with the project's real evaluator:

```bash
npm run eval -- data/samples/baseline-release-package.json
npm run eval -- data/samples/abstractive-release-package.json
```

### `baseline-release-package.json` — deterministic extractive baseline
Produced by `npm run capture` with **no API key**: every agent's LLM call resolves to
the deterministic, grounded extractive baseline. This is exactly what the app serves
offline.

### `abstractive-release-package.json` — abstractive (read this provenance note)
The **Release Writer** and **Documentation Reviewer** artifacts here were generated
**abstractively by Claude (Opus) via an interactive Claude Code session — NOT by the
app's live `AnthropicProvider` API call.** The test API account had no credits, so the
live SDK path was exercised only up to the billing gate (auth + structured-output
request construction confirmed working, then `400: credit balance too low`). The
change set, plan, and retrieval in this package are the **deterministic pipeline's**;
only the generated prose and the doc-target *selection* are abstractive. It is included
to show the abstractive ceiling, and it was scored by the project's **real eval** to
confirm it stays grounded.

### Eval comparison (real `npm run eval`)

| Metric | Baseline (extractive) | Abstractive |
|---|---|---|
| Hallucination | 0.0% | **0.0%** |
| Ticket coverage | 7/7 | 7/7 |
| Doc-rec precision | 66.7% | **100.0%** |
| Doc-rec recall | 66.7% | 66.7% |
| Doc-rec F1 | 66.7% | **80.0%** |
| Changelog substantive recall | 100% | 100% |

The abstractive Documentation Reviewer reasons away two irrelevant `alternatives.md`
suggestions the extractive top-hit logic made (precision 66.7% → 100%), while staying
fully grounded (0% hallucination). The remaining recall miss (`openapi-callbacks.md`)
is **not retrieved even at k=8** — a *retrieval* limitation, not a generation one,
which motivates the cross-encoder reranker in [DESIGN → Future improvements](../../docs/DESIGN.md#future-improvements).
