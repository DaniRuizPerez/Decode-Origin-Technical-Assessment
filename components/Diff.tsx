/**
 * Zero-dependency diff renderers (read-only display → a Tailwind-colored `<pre>`
 * is exact and costs nothing; no diff library).
 *
 * `PatchView` colors a pre-formatted GitHub unified-diff `patch`; `LineDiff`
 * renders a before→after line diff computed by the pure `diffLines` util.
 */

import { diffLines } from "@/lib/diff";

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

/** Render a before→after line diff (context / +added / −removed). */
export function LineDiff({ before, after }: { before: string; after: string }) {
  const rows = diffLines(before, after);
  return (
    <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-2 text-[11px] leading-4">
      {rows.map((r, i) => {
        const cls =
          r.type === "add"
            ? "bg-emerald-50 text-emerald-700"
            : r.type === "del"
              ? "bg-rose-50 text-rose-700"
              : "text-gray-600";
        const sign = r.type === "add" ? "+" : r.type === "del" ? "−" : " ";
        return (
          <div key={i} className={`whitespace-pre-wrap ${cls}`}>
            {sign} {r.text || " "}
          </div>
        );
      })}
    </pre>
  );
}
