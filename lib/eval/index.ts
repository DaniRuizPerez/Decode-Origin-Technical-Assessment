/**
 * Public API of the evaluation framework.
 *
 * The eval suite scores a generated `ReleasePackage` against the project's own
 * reality (curated gold + harvested ground truth). It is intentionally separate
 * from the generation pipeline and from the `Connector` port — evaluation reads
 * reference data the runtime never touches — so importing from `@/lib/eval`
 * pulls in metrics only, with no risk of coupling the pipeline to the grader.
 */

export {
  // metric functions
  hallucinationRate,
  ticketCoverage,
  docRecommendationAccuracy,
  changelogRecall,
  runEval,
  // shared id helpers (exported so the CLI / other tools can reuse the parsing)
  parsePrNumber,
  parseTicketKey,
  SUBSTANTIVE_CATEGORIES,
  // result types
  type FlaggedItem,
  type HallucinationResult,
  type TicketCoverageResult,
  type DocRecommendationResult,
  type RecallSlice,
  type ChangelogRecallResult,
  type EvalReport,
} from "./metrics";

export { main, formatReport } from "./run";
