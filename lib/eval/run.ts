/**
 * `npm run eval` — score a generated `ReleasePackage` against the reference data.
 *
 * The real logic lives here (not in `scripts/eval.ts`) so it is importable and
 * testable; `scripts/eval.ts` is a one-line wrapper that calls `main()`. The
 * package.json `eval` script points at that wrapper.
 *
 * Behaviour:
 *  - Loads ground-truth + curated-gold + release-input through the connector
 *    (offline-first — reads only `data/`).
 *  - Reads a `ReleasePackage` from the path in `process.argv[2]`, validates it
 *    against the schema, runs `runEval`, and pretty-prints the report.
 *  - If no package path is given (the generation pipeline isn't built yet), it
 *    prints a clear "no package provided" message plus a ground-truth summary, so
 *    the command is useful on its own and exits 0.
 *
 * Exit codes: 0 on success or the no-package path; 1 on a real error (bad path,
 * malformed package JSON). This keeps it CI-friendly once the pipeline exists.
 */

import { readFileSync } from "node:fs";

import { getConnector, loadGroundTruth, loadCuratedGold } from "@/lib/connectors";
import {
  ReleasePackageSchema,
  type ReleasePackage,
  type GroundTruth,
} from "@/lib/schemas";

import { runEval, SUBSTANTIVE_CATEGORIES, type EvalReport } from "./metrics";

/** Render a 0..1 ratio as a percentage with one decimal (e.g. `66.7%`). */
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Map a provider name (`getProvider().name`) to a human-readable generation-regime
 * label for the report's `Source:` line, so the metrics are self-describing about
 * how the scored package was produced THIS run. Only valid for live/keyed runs that
 * actually generated the package — NOT for scoring a saved file of unknown origin.
 */
export function regimeLabel(providerName: string): string {
  switch (providerName) {
    case "mock":
      return "deterministic extractive baseline — grounded by construction";
    case "anthropic":
      return "abstractive — claude-opus-4-8";
    default:
      return providerName;
  }
}

/**
 * A human-readable summary of the harvested ground truth — shown when no package
 * is supplied so the operator can see *what the eval will grade against* even
 * before the pipeline produces anything.
 */
function formatGroundTruthSummary(gt: GroundTruth): string {
  // Count PRs per category to show the substantive-vs-noise split that justifies
  // the changelog-recall methodology.
  const counts = new Map<string, number>();
  for (const category of Object.values(gt.releaseNotePrCategories)) {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const substantiveTotal = [...counts.entries()]
    .filter(([c]) => SUBSTANTIVE_CATEGORIES.has(c))
    .reduce((sum, [, n]) => sum + n, 0);

  const categoryLines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => {
      const tag = SUBSTANTIVE_CATEGORIES.has(c) ? "  (substantive)" : "";
      return `      ${c.padEnd(18)} ${String(n).padStart(3)}${tag}`;
    })
    .join("\n");

  return [
    `  Ground truth — ${gt.release.project} ${gt.release.baseRef}…${gt.release.headRef}`,
    `    release-note PRs: ${gt.releaseNotePrNumbers.length} total, ${substantiveTotal} substantive`,
    `    changed docs (weak proxy): ${gt.changedDocPaths.length}`,
    `    PRs by category:`,
    categoryLines,
  ].join("\n");
}

/**
 * Pretty-print a full `EvalReport`. Returns the string (also used in tests).
 *
 * @param sourceLabel optional regime/provenance label. When provided, a
 *   `Source: <label>` line is added under the header so the numbers can never be
 *   misread (e.g. the deterministic extractive baseline mistaken for Claude's
 *   abstractive output, or a saved file mistaken for a live keyed run).
 */
export function formatReport(report: EvalReport, sourceLabel?: string): string {
  const { hallucination, ticketCoverage, docRecommendation, changelogRecall } = report;
  const lines: string[] = [];

  lines.push(
    `Eval report — ${report.release.project} ${report.release.baseRef}…${report.release.headRef}`,
  );
  if (sourceLabel) {
    lines.push(`Source: ${sourceLabel}`);
  }
  lines.push("");

  // --- Hallucination ---
  lines.push("Hallucination (ungrounded artifact items)");
  lines.push(
    `  rate: ${pct(hallucination.rate)}  (${hallucination.hallucinatedItems}/${hallucination.totalItems} items)`,
  );
  for (const f of hallucination.flagged.slice(0, 10)) {
    const why = f.badSources.length === 0 ? "no sources" : `bad: ${f.badSources.join(", ")}`;
    lines.push(`    - [${f.kind}] ${f.label} — ${why}`);
  }
  if (hallucination.flagged.length > 10) {
    lines.push(`    … and ${hallucination.flagged.length - 10} more`);
  }
  lines.push("");

  // --- Ticket coverage ---
  lines.push("Ticket coverage");
  lines.push(
    `  covered: ${ticketCoverage.covered}/${ticketCoverage.total}` +
      (ticketCoverage.missingTicketKeys.length > 0
        ? `  (missing: ${ticketCoverage.missingTicketKeys.join(", ")})`
        : ""),
  );
  lines.push("");

  // --- Doc recommendation ---
  const p = docRecommendation.primary;
  lines.push("Doc-recommendation accuracy");
  lines.push(`  PRIMARY (vs curated gold):`);
  lines.push(
    `    precision ${pct(p.precision)}  recall ${pct(p.recall)}  F1 ${pct(p.f1)}` +
      `  (TP ${p.truePositives.length}, FP ${p.falsePositives.length}, FN ${p.falseNegatives.length})`,
  );
  if (p.falseNegatives.length > 0) {
    lines.push(`    missed gold docs: ${p.falseNegatives.join(", ")}`);
  }
  lines.push(
    `  SECONDARY (vs changed-docs proxy — recall LOWER BOUND, noisy): ${pct(
      docRecommendation.proxy.recallLowerBound,
    )}`,
  );
  lines.push(
    `  possible doc debt (recommended but project didn't touch): ${docRecommendation.possibleDocDebtCount}` +
      (docRecommendation.possibleDocDebtCount > 0
        ? `  — investigate, may be correct finds, NOT errors`
        : ""),
  );
  lines.push("");

  // --- Changelog recall ---
  const s = changelogRecall.substantive;
  lines.push("Changelog recall");
  lines.push(
    `  SUBSTANTIVE (headline): recall ${pct(s.recall)}  (${s.matched.length}/${s.relevant.length} PRs)`,
  );
  if (s.missed.length > 0) {
    lines.push(`    missed: ${s.missed.join(", ")}`);
  }
  lines.push(
    `  overall (all categories): recall ${pct(changelogRecall.overall.recall)}` +
      `  precision ${pct(changelogRecall.overall.precision)}  (low overall recall is expected — most PRs are noise)`,
  );
  lines.push(`  by category:`);
  for (const [category, slice] of Object.entries(changelogRecall.byCategory).sort()) {
    const tag = SUBSTANTIVE_CATEGORIES.has(category) ? "*" : " ";
    lines.push(
      `    ${tag} ${category.padEnd(18)} ${pct(slice.recall).padStart(6)}  (${slice.matched.length}/${slice.relevant.length})`,
    );
  }

  return lines.join("\n");
}

/**
 * CLI entry point. Returns the process exit code instead of calling
 * `process.exit` directly, so it stays unit-testable.
 *
 * @param argv defaults to `process.argv` — the package path is `argv[2]`.
 */
export function main(argv: string[] = process.argv): number {
  // Load the reference data up-front; this also validates it (the connector
  // parses through the schemas), so a corrupt fixture fails loudly here.
  const input = getConnector().loadReleaseInput();
  const gt = loadGroundTruth();
  const curated = loadCuratedGold();

  const packagePath = argv[2];

  if (!packagePath) {
    // No package yet (pipeline not built). Still useful: show what we'd grade.
    console.log(
      [
        "No ReleasePackage provided.",
        "",
        "Usage: npm run eval -- <path/to/release-package.json>",
        "",
        "The generation pipeline isn't wired in yet, so there's nothing to score.",
        "Here is the ground truth the eval would grade against:",
        "",
        formatGroundTruthSummary(gt),
        "",
        `Curated-gold impacted docs (PRIMARY doc-rec set): ${curated.impactedDocs.length}`,
        ...curated.impactedDocs.map((d) => `    - ${d.docPath}`),
      ].join("\n"),
    );
    return 0;
  }

  // Read and validate the package. A malformed file is a real error (exit 1).
  let pkg: ReleasePackage;
  try {
    const raw = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg = ReleasePackageSchema.parse(raw);
  } catch (err) {
    console.error(`Failed to load ReleasePackage from ${packagePath}:`);
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const report = runEval(pkg, input, gt, curated);
  // Saved-file path: label by provenance (the file we scored), NOT by provider —
  // we did not generate this package this run and must not claim "anthropic"/"mock"
  // regime for a file of unknown origin.
  console.log(formatReport(report, `scored from saved package: ${packagePath}`));
  return 0;
}
