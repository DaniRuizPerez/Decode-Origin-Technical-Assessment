/**
 * Minimal, dependency-free line diff for the before→after doc-suggestion view.
 *
 * Strategy: strip the common prefix and suffix, then mark the changed middle as
 * removed (from `before`) followed by added (from `after`). This is EXACT for
 * insert/append edits (the offline "suggested addition" case) and a coarse but
 * readable block diff for arbitrary rewrites (the keyed case) — no LCS/library.
 */

export type DiffRow = { type: "ctx" | "add" | "del"; text: string };

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ type: "ctx", text: a[i] });
  for (let i = start; i < endA; i++) rows.push({ type: "del", text: a[i] });
  for (let i = start; i < endB; i++) rows.push({ type: "add", text: b[i] });
  for (let i = endA; i < a.length; i++) rows.push({ type: "ctx", text: a[i] });
  return rows;
}
