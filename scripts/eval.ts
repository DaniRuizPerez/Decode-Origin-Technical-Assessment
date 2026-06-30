/**
 * `npm run eval` entrypoint. Two modes:
 *
 *  - `npm run eval -- <path>`  → score a saved `ReleasePackage` JSON (e.g. a
 *    keyed `capture` run). Defers to lib/eval's tested `main` (validates + scores).
 *  - `npm run eval` (no path)  → run the LIVE pipeline over the real fixtures and
 *    score its output: the offline extractive baseline by default, or abstractive
 *    output when ANTHROPIC_API_KEY is set. This is the end-to-end
 *    "does the whole thing work, and how good is it" command.
 *
 * All scoring + formatting logic lives in lib/eval (importable + unit-tested);
 * this wrapper only wires the live pipeline to it.
 */

import { getConnector, loadCuratedGold, loadGroundTruth } from "@/lib/connectors";
import { runEval } from "@/lib/eval/metrics";
import { formatReport, main, regimeLabel } from "@/lib/eval/run";
import { getProvider } from "@/lib/llm";
import { runPipeline } from "@/lib/pipeline";

async function run(): Promise<number> {
  // Explicit package path → use the tested CLI (validates + scores a saved file).
  if (process.argv[2]) return main(process.argv);

  // No path → generate live and score it end-to-end.
  const provider = getProvider();
  console.log(
    `Generating release package via the live pipeline (provider: ${provider.name})…\n`,
  );
  const pkg = await runPipeline({ provider });
  const input = getConnector().loadReleaseInput();
  const report = runEval(pkg, input, loadGroundTruth(), loadCuratedGold());
  console.log(formatReport(report, regimeLabel(provider.name)));
  return 0;
}

run().then((code) => process.exit(code));
