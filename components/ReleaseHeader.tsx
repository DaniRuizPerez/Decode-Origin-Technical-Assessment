/**
 * Release summary header — the at-a-glance verdict for a reviewer.
 *
 * WHY it shows risk *reasons* and coverage, not just a label: the schema models
 * risk as { level, reasons[] } precisely so the system is explainable. A bare
 * "HIGH" pill is not actionable; listing the concrete reasons (and the
 * coverage/confidence meters) lets a human decide whether to approve. This is a
 * pure server component — no interactivity here.
 */

import type { ReleasePackage } from "@/lib/schemas";
import { RiskBadge, Meter, CodeChip } from "./ui";

export function ReleaseHeader({ pkg }: { pkg: ReleasePackage }) {
  const { release, plan, changeSet } = pkg;

  // Average change confidence — a single readable signal of evidence strength.
  // WHY computed here (not in the sample): it is a derived view of the data, so
  // it stays correct if the change set is later swapped for live pipeline output.
  const avgConfidence =
    changeSet.changes.length === 0
      ? 0
      : changeSet.changes.reduce((s, c) => s + c.confidence, 0) /
        changeSet.changes.length;

  const coveragePct =
    plan.coverage.total === 0
      ? 0
      : Math.round((plan.coverage.covered / plan.coverage.total) * 100);

  return (
    <header className="rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Release documentation review
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            {release.project}{" "}
            <span className="text-gray-400">·</span>{" "}
            <span className="text-indigo-600">{release.name ?? release.headRef}</span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-600">
            <span>Window</span>
            <CodeChip>{release.baseRef}</CodeChip>
            <span aria-hidden>→</span>
            <CodeChip>{release.headRef}</CodeChip>
            <span className="text-gray-400">·</span>
            <span>
              {changeSet.changes.length} change
              {changeSet.changes.length === 1 ? "" : "s"} in{" "}
              {plan.themes.length} theme{plan.themes.length === 1 ? "" : "s"}
            </span>
          </p>
        </div>

        <div className="flex flex-col items-end gap-3">
          <RiskBadge level={plan.risk.level} />
          <div className="flex gap-6">
            <Meter
              label="Ticket coverage"
              value={plan.coverage.covered}
              max={plan.coverage.total}
              tone={coveragePct >= 80 ? "emerald" : coveragePct >= 50 ? "amber" : "indigo"}
            />
            <Meter
              label="Avg confidence"
              value={avgConfidence}
              tone={avgConfidence >= 0.8 ? "emerald" : "amber"}
            />
          </div>
        </div>
      </div>

      {/* Explainable risk: the concrete reasons behind the level. */}
      {plan.risk.reasons.length > 0 ? (
        <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">
            Why {plan.risk.level} risk
          </p>
          <ul className="mt-2 space-y-1.5">
            {plan.risk.reasons.map((reason, i) => (
              <li key={i} className="flex gap-2 text-sm text-rose-900">
                <span className="mt-0.5 select-none text-rose-400" aria-hidden>
                  •
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Affected systems + the incomplete-information signal, side by side. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-gray-600">Affected systems:</span>
          {plan.affectedSystems.map((s) => (
            <span
              key={s}
              className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"
            >
              {s}
            </span>
          ))}
        </div>
        {changeSet.unlinkedArtifactIds.length > 0 ? (
          <div className="flex items-center gap-2 text-amber-700">
            <span className="font-medium">Incomplete information:</span>
            <span>
              {changeSet.unlinkedArtifactIds.length} artifact
              {changeSet.unlinkedArtifactIds.length === 1 ? "" : "s"} with no
              linked ticket
            </span>
          </div>
        ) : null}
      </div>
    </header>
  );
}
