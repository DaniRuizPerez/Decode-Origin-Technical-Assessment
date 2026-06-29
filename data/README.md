# `data/` — real-derived, frozen mock fixtures

The ingestion layer reads only this directory and **never touches the network at
runtime**. The fixtures under `mocks/` are *real-derived* — harvested once from a
real OSS release window by [`scripts/harvest.ts`](../scripts/harvest.ts) and committed
verbatim — so the system is exercised on authentic, messy, untuned data rather than a
fixture hand-tailored to look good.

> ⚠️ **`mocks/` is regenerated wholesale by `npm run harvest`; do not hand-edit it.**
> Hand-curated data (the doc-recommendation gold set) lives at `curated-gold.json`,
> *outside* `mocks/`, so re-harvesting can't clobber it.

## Source window

- **Project:** [`fastapi/fastapi`](https://github.com/fastapi/fastapi)
- **Window:** `0.136.0 … 0.137.2` — 6 aggregated releases. FastAPI ships small
  incremental releases, so we aggregate to get a realistic mix: a breaking change, a
  feature, fixes, refactors, an upgrade, and many docs/translation/internal PRs.

## Files

| Path | What it is |
|---|---|
| `mocks/release.json` | The release window reference (project, base/head tags). |
| `mocks/commits.json` | Real commits; subject lines carry the squash-merge `(#PR)` refs used for linkage. |
| `mocks/pulls.json` | Real merged PRs (full body/files for the ~32 most substantive; title/number for the rest). |
| `mocks/tickets.json` | **Reconstructed Jira-shaped tickets** — one per *substantive* PR (feature/fix/breaking/refactor/upgrade), linked to it. Translation/internal/chore PRs are intentionally **ticketless**, which is what drives the incomplete-information and coverage behavior. |
| `mocks/docs/*.md` | Existing English docs **at the base tag** (the "before" state), flattened (`a/b.md` → `a__b.md`), capped at 60 (changed-docs first, then distractors). |
| `mocks/ground-truth.json` | Auto-generated eval signals: PR numbers + categories from the union of the window's release notes, and the doc files that actually changed (a **weak proxy** — see DESIGN). |
| `curated-gold.json` | Hand-curated **primary** doc-recommendation gold set (real inputs, human-judged labels; single annotator). |

## Re-harvest

```bash
npm run harvest                                              # default window above
HARVEST_REPO=owner/repo HARVEST_BASE=vX HARVEST_HEAD=vY npm run harvest
```

Requires the [`gh`](https://cli.github.com/) CLI authenticated with `repo` scope.
