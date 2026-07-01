/**
 * Zero-dependency diff renderers (read-only display, so a Tailwind-colored `<pre>`
 * is exact and costs nothing — no diff library).
 *
 * `PatchView` colors a GitHub unified-diff `patch` string (already formatted with
 * `@@` hunk headers and `+`/`-` lines).
 */

/** Render a unified-diff patch string with `+`/`-`/`@@` line coloring. */
export function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-2 text-[11px] leading-4">
      {patch.split("\n").map((line, i) => {
        const c = line[0];
        const cls =
          c === "+"
            ? "bg-emerald-50 text-emerald-700"
            : c === "-"
              ? "bg-rose-50 text-rose-700"
              : c === "@"
                ? "text-indigo-600"
                : "text-gray-600";
        return (
          <div key={i} className={`whitespace-pre-wrap ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
