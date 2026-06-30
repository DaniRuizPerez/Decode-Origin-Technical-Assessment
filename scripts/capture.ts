/**
 * `npm run capture` — run the pipeline with the configured provider, save the
 * resulting ReleasePackage to disk, and print its eval report.
 *
 * Purpose: the keyed run. With `ANTHROPIC_API_KEY` set, `getProvider()` returns
 * the Anthropic provider, so this captures **real abstractive output** (and its
 * faithfulness/quality numbers) as a committable artifact for the submission.
 * With no key it captures the deterministic extractive baseline — handy for a
 * stable reference snapshot too.
 *
 * Output path: `process.argv[2]` or `data/captured-release-package.json`.
 * Score a saved capture later with: `npm run eval -- <path>`.
 */

import { writeFileSync } from "node:fs";

import { getConnector, loadCuratedGold, loadGroundTruth } from "@/lib/connectors";
import { runEval } from "@/lib/eval/metrics";
import { formatReport, regimeLabel } from "@/lib/eval/run";
import { getProvider } from "@/lib/llm";
import { runPipeline } from "@/lib/pipeline";

async function main(): Promise<void> {
  const provider = getProvider();
  const outPath = process.argv[2] ?? "data/captured-release-package.json";

  console.log(`Running pipeline (provider: ${provider.name}) → ${outPath}\n`);
  const pkg = await runPipeline({ provider });
  writeFileSync(outPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const input = getConnector().loadReleaseInput();
  console.log(
    formatReport(runEval(pkg, input, loadGroundTruth(), loadCuratedGold()), regimeLabel(provider.name)),
  );
  console.log(`\nSaved package to ${outPath} (score later with: npm run eval -- ${outPath})`);
}

main().then(() => process.exit(0));
