/**
 * Release summary — the required at-a-glance header (spec UI: "Release summary").
 *
 * Release identity, the tag window, the change count, and the generated one-line
 * Overview. Risk, affected systems, and coverage are content of the release notes
 * below (matching the spec's example), so they are not duplicated here. Pure server
 * component — no interactivity.
 */

import type { ReleasePackage } from "@/lib/schemas";
import { CodeChip } from "./ui";

export function ReleaseHeader({ pkg }: { pkg: ReleasePackage }) {
  const { release, changeSet } = pkg;
  const n = changeSet.changes.length;
  // The Release Writer's grounded one-line summary (the first "Overview" note).
  // Shown here as the actual summary; the internal-notes panel skips it to avoid
  // rendering the same sentence twice.
  const overview = pkg.artifacts.internalReleaseNotes.find(
    (s) => s.heading === "Overview",
  )?.body;

  return (
    <header className="rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-6 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        Release summary
      </p>
      <h1 className="mt-1 text-2xl font-bold text-gray-900">
        {release.project} <span className="text-gray-400">·</span>{" "}
        <span className="text-indigo-600">{release.name ?? release.headRef}</span>
      </h1>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <span>Window</span>
        <CodeChip>{release.baseRef}</CodeChip>
        <span aria-hidden>→</span>
        <CodeChip>{release.headRef}</CodeChip>
        <span className="text-gray-400">·</span>
        <span>
          {n} change{n === 1 ? "" : "s"}
        </span>
      </p>
      {overview ? (
        <p className="mt-3 text-sm leading-relaxed text-gray-700">{overview}</p>
      ) : null}
    </header>
  );
}
