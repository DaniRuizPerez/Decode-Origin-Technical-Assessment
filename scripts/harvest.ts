/**
 * Harvest a real OSS release window into frozen mock fixtures.
 *
 * This is a ONE-TIME build tool, not part of the runtime. It pulls real data
 * from a real project (default: FastAPI) for a release window (two tags) and
 * writes it to `data/mocks/` as JSON + markdown. The application then reads
 * only those local files — it never touches the network at runtime. So the data
 * is *real-derived* but the ingestion is fully mocked, exactly as intended.
 *
 * Why a real project instead of a hand-built fixture: it exercises the system on
 * untuned, messy data (terse commits, translation noise, docs that may be stale)
 * and lets us evaluate against the project's *own* published reality (the union
 * of release notes + the docs that actually changed). See DESIGN for the eval
 * methodology and the data-quality acceptance gate this script reports against.
 *
 * Two deliberate, documented modelling choices (see DESIGN → Assumptions):
 *   - **Wide window.** FastAPI ships small incremental releases, so we aggregate
 *     several (e.g. 0.136.0→0.137.2) into one "release" to get a realistic mix of
 *     features, fixes, a breaking change, upgrades, and docs.
 *   - **Reconstructed tickets.** FastAPI PRs don't link Jira issues, so we
 *     reconstruct Jira-shaped tickets from the *substantive* PRs (features, fixes,
 *     breaking, refactors, upgrades). Translation/internal/chore PRs are left
 *     ticketless on purpose — that partial linkage is what exercises the
 *     incomplete-information and ticket-coverage paths.
 *
 * Auth/transport: shells out to the authenticated `gh` CLI (5000/hr, no tokens here).
 * Run: `npm run harvest`  (override via env: HARVEST_REPO / HARVEST_BASE / HARVEST_HEAD)
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration — the chosen window (see DESIGN for why this one).
// ---------------------------------------------------------------------------
const REPO = process.env.HARVEST_REPO ?? "fastapi/fastapi";
const BASE = process.env.HARVEST_BASE ?? "0.136.0"; // exclusive lower bound
const HEAD = process.env.HARVEST_HEAD ?? "0.137.2"; // inclusive upper bound (the release)
const OUT = join(process.cwd(), "data", "mocks");
const DOCS_OUT = join(OUT, "docs");

const MAX_PR_DETAILS = 32; // fetch full body/files for at most this many (non-noise first)
const MAX_DOCS = 60; // cap the existing-docs corpus so RAG stays fast / snapshot small

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------
function ghJson<T = any>(endpoint: string, paginate = false): T {
  const args = ["api", endpoint, ...(paginate ? ["--paginate"] : [])];
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(out) as T;
}
function ghJsonSafe<T = any>(endpoint: string, paginate = false): T | null {
  try {
    return ghJson<T>(endpoint, paginate);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small parsing/linkage helpers
// ---------------------------------------------------------------------------

/** "0.137.0" vs "0.136.3" → negative/zero/positive (semver-lite, X.Y.Z). */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
const inWindow = (tag: string) => cmpVersion(tag, BASE) > 0 && cmpVersion(tag, HEAD) <= 0;

/** Extract a PR number from a squash-merge commit subject like "... (#15745)". */
function prNumberFromCommitMessage(message: string): number | null {
  const m = message.match(/\(#(\d+)\)/);
  return m ? Number(m[1]) : null;
}

/** A release-notes category is "substantive" if it warrants a ticket. */
const isSubstantive = (cat: string) => /break|feature|fix|refactor|upgrade|perf|security/i.test(cat);

/** Map a release-notes category to a Jira issue type. */
function issueTypeFromCategory(cat: string): string {
  const c = cat.toLowerCase();
  if (c.includes("break") || c.includes("feature")) return "story";
  if (c.includes("fix")) return "bug";
  if (c.includes("refactor") || c.includes("upgrade") || c.includes("perf")) return "improvement";
  return "task";
}

// Release-notes lines look like:
//   "* <emoji> <title>. PR [#15724](.../pull/15724) by [@x](...)."
// grouped under "### Features", "### Fixes", "### Breaking Changes", etc.
interface NotePr {
  number: number;
  title: string;
  category: string;
}
function parseReleaseNotes(body: string): NotePr[] {
  const prs: NotePr[] = [];
  let category = "Other";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const head = line.match(/^#{2,4}\s+(.+)$/);
    if (head) {
      category = head[1].trim();
      continue;
    }
    const pr = line.match(/pull\/(\d+)/);
    if (line.startsWith("*") && pr) {
      let title = line.replace(/^\*\s*/, "").split(/\.?\s*PR \[/)[0].trim();
      title = title.replace(/^[^\w`("']+\s*/, "").trim() || title; // strip leading emoji
      prs.push({ number: Number(pr[1]), title, category });
    }
  }
  return prs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Harvesting ${REPO} ${BASE}...${HEAD}`);
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(DOCS_OUT, { recursive: true });

  // --- 1. Commits + changed files for the whole window (one compare call). --
  // Note: the compare endpoint returns up to 250 commits / 300 files; for our
  // window that is plenty, and the authoritative change list comes from the
  // unioned release notes below regardless.
  const compare = ghJson<any>(`repos/${REPO}/compare/${BASE}...${HEAD}`);
  const commits: any[] = (compare.commits ?? []).map((c: any) => {
    const message: string = c.commit.message;
    const prNum = prNumberFromCommitMessage(message);
    return {
      id: `commit:${c.sha.slice(0, 7)}`,
      sha: c.sha,
      message,
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? "",
      files: [] as string[],
      prNumbers: prNum ? [prNum] : [],
      ticketKeys: [] as string[], // FastAPI commits don't carry Jira keys
    };
  });
  const changedFiles: string[] = (compare.files ?? []).map((f: any) => f.filename);
  const changedDocPaths = changedFiles.filter((f) => /^docs\/en\/docs\/.*\.md$/.test(f));
  console.log(`  commits=${commits.length} (compare total=${compare.total_commits}) changedDocs=${changedDocPaths.length}`);

  // --- 2. Union release notes across every release in (BASE, HEAD]. --------
  const allReleases = ghJson<any[]>(`repos/${REPO}/releases?per_page=100`, true);
  const windowReleases = allReleases.filter((r) => inWindow(r.tag_name));
  const notePrs: NotePr[] = [];
  for (const r of windowReleases) if (r.body) notePrs.push(...parseReleaseNotes(r.body));
  const categoryByPr = new Map<number, string>();
  const titleByPr = new Map<number, string>();
  for (const p of notePrs) {
    categoryByPr.set(p.number, p.category);
    titleByPr.set(p.number, p.title);
  }
  console.log(`  window releases=${windowReleases.map((r) => r.tag_name).join(",")}  note PRs=${categoryByPr.size}`);

  // --- 3. PR details (cap; prioritize substantive over translation/internal). -
  const commitPrNums = new Set<number>(commits.flatMap((c) => c.prNumbers));
  const allPrNums = [...new Set<number>([...commitPrNums, ...categoryByPr.keys()])];
  const ranked = [...allPrNums].sort((a, b) => {
    const score = (n: number) => {
      const cat = (categoryByPr.get(n) ?? "").toLowerCase();
      if (cat.includes("translation")) return 0;
      if (cat.includes("break")) return 4;
      if (cat.includes("feature")) return 3;
      if (cat.includes("fix") || cat.includes("upgrade") || cat.includes("refactor")) return 2;
      if (cat.includes("internal")) return 1;
      return 1;
    };
    return score(b) - score(a) || b - a;
  });
  const detailNums = new Set(ranked.slice(0, MAX_PR_DETAILS));

  const pulls: any[] = [];
  for (const n of [...allPrNums].sort((a, b) => a - b)) {
    let pr: any = null;
    // Changed files with their unified-diff patch + line counts. Caps keep the
    // fixture lean: no patches for mega-PRs (>20 files, e.g. translations), and any
    // single patch >8 KB (or binary/null) is dropped to a path-only entry.
    let files: { path: string; patch: string | null; additions: number; deletions: number }[] = [];
    if (detailNums.has(n)) {
      pr = ghJsonSafe<any>(`repos/${REPO}/pulls/${n}`);
      const prFiles = ghJsonSafe<any[]>(`repos/${REPO}/pulls/${n}/files?per_page=100`) ?? [];
      const tooMany = prFiles.length > 20;
      files = prFiles.map((f) => ({
        path: f.filename,
        patch:
          !tooMany && typeof f.patch === "string" && f.patch.length <= 8192 ? f.patch : null,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      }));
    }
    pulls.push({
      id: `pr:${n}`,
      number: n,
      title: pr?.title ?? titleByPr.get(n) ?? `PR #${n}`,
      body: (pr?.body ?? "").slice(0, 4000),
      author: pr?.user?.login ?? "unknown",
      mergedAt: pr?.merged_at ?? null,
      labels: (pr?.labels ?? []).map((l: any) => l.name),
      files,
      commitShas: commits.filter((c) => c.prNumbers.includes(n)).map((c) => c.sha),
      ticketKeys: [] as string[], // filled below for substantive PRs
    });
  }
  console.log(`  pulls=${pulls.length} (detailed=${detailNums.size})`);

  // --- 4. Reconstruct Jira-shaped tickets from substantive PRs. -------------
  // A ticket models the *intended work*; we link it to the PR that delivered it.
  // Non-substantive PRs (translations, internal/chore) get no ticket → unlinked.
  const tickets: any[] = [];
  let ticketSeq = 1000;
  for (const p of pulls) {
    const cat = categoryByPr.get(p.number) ?? "";
    if (!isSubstantive(cat)) continue;
    const key = `FAPI-${ticketSeq++}`;
    p.ticketKeys = [key];
    tickets.push({
      id: `ticket:${key}`,
      key,
      summary: p.title,
      description:
        (p.body ? p.body.slice(0, 1200) : `Tracking work delivered in PR #${p.number}.`) +
        `\n\n(Reconstructed from PR #${p.number}; category: ${cat}.)`,
      issueType: issueTypeFromCategory(cat),
      status: p.mergedAt ? "Done" : "In Progress",
      components: [],
      fixVersions: [HEAD],
      prNumbers: [p.number],
    });
  }
  console.log(`  tickets (reconstructed)=${tickets.length}`);

  // --- 5. Existing docs at BASE (changed docs first, then sampled others). --
  const tree = ghJsonSafe<any>(`repos/${REPO}/git/trees/${BASE}?recursive=1`);
  const allDocPaths: string[] = (tree?.tree ?? [])
    .map((t: any) => t.path as string)
    .filter((p: string) => /^docs\/en\/docs\/.*\.md$/.test(p));
  const changedSet = new Set(changedDocPaths);
  const selectedDocs = [
    ...changedDocPaths.filter((p) => allDocPaths.includes(p)),
    ...allDocPaths.filter((p) => !changedSet.has(p)),
  ].slice(0, MAX_DOCS);

  const flatten = (p: string) => p.replace(/^docs\/en\/docs\//, "").replace(/\//g, "__");
  let docCount = 0;
  for (const path of selectedDocs) {
    const content = ghJsonSafe<any>(`repos/${REPO}/contents/${path}?ref=${BASE}`);
    if (!content?.content) continue;
    const text = Buffer.from(content.content, "base64").toString("utf8");
    writeFileSync(join(DOCS_OUT, flatten(path)), `<!-- source: ${path} @ ${BASE} -->\n${text}`);
    docCount++;
  }
  console.log(`  docs harvested=${docCount} (of ${allDocPaths.length} en docs)`);

  // --- 6. Write JSON fixtures + ground truth. ------------------------------
  const releaseRef = { project: REPO, baseRef: BASE, headRef: HEAD, name: HEAD };
  writeFileSync(join(OUT, "release.json"), JSON.stringify(releaseRef, null, 2));
  writeFileSync(join(OUT, "commits.json"), JSON.stringify(commits, null, 2));
  writeFileSync(join(OUT, "pulls.json"), JSON.stringify(pulls, null, 2));
  writeFileSync(join(OUT, "tickets.json"), JSON.stringify(tickets, null, 2));
  writeFileSync(
    join(OUT, "ground-truth.json"),
    JSON.stringify(
      {
        release: releaseRef,
        releaseNotePrNumbers: [...categoryByPr.keys()].sort((a, b) => a - b),
        // PR number → release-notes category, so the eval can measure changelog
        // recall over substantive categories and credit correct noise exclusion.
        releaseNotePrCategories: Object.fromEntries(
          [...categoryByPr.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([n, c]) => [String(n), c]),
        ),
        changedDocPaths: changedDocPaths.map(flatten),
        // NOTE: the hand-curated gold set lives in data/curated-gold.json (outside
        // data/mocks/, which this script regenerates) so re-harvesting can't clobber it.
      },
      null,
      2,
    ),
  );

  // --- 7. Acceptance-gate summary. -----------------------------------------
  const catCounts: Record<string, number> = {};
  for (const [, c] of categoryByPr) catCounts[c] = (catCounts[c] ?? 0) + 1;
  const linked = pulls.filter((p) => p.ticketKeys.length > 0).length;
  console.log("\n=== ACCEPTANCE-GATE SUMMARY ===");
  console.log(`window: ${REPO} ${BASE}...${HEAD}  (${windowReleases.length} releases)`);
  console.log(`commits=${commits.length} pulls=${pulls.length} tickets=${tickets.length} docs=${docCount}`);
  console.log(`PRs linked-to-ticket=${linked} unlinked=${pulls.length - linked}  changedDocs=${changedDocPaths.length}`);
  console.log(`release-note categories:`, catCounts);
}

main().catch((e) => {
  console.error("Harvest failed:", e);
  process.exit(1);
});
