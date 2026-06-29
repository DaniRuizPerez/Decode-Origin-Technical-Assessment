/**
 * Deterministic reference verifier — the offline half of the grounding loop.
 *
 * The pipeline's anti-hallucination guarantee is "every generated claim is
 * traceable to a real source artifact" (see lib/schemas: `sources[]` carries
 * ids of the commits / PRs / tickets that justify each item). This module is the
 * cheap, deterministic check of that guarantee: given the set of source ids that
 * actually exist in the release window, it confirms each cited id is real and
 * flags any item that cites nothing or cites something fabricated.
 *
 * WHY deterministic (not an LLM judge): citation existence is a set-membership
 * fact, not a matter of opinion. Checking it with `Set.has` is exact, instant,
 * and runs offline with zero tokens — so it belongs in the in-loop verifier that
 * gates every generation. A *semantic* claim-verifier ("does the cited PR
 * actually support this sentence?") is a genuine judgment call and is documented
 * as a future LLM-backed extension layered on top of this same report shape.
 */

/**
 * Result of verifying one item's citation list against the known-good id set.
 *
 * The three fields are intentionally orthogonal so callers can distinguish *why*
 * an item is unsupported:
 *  - `empty`   — the item cited nothing at all (an ungrounded claim).
 *  - `unknownIds` — ids that were cited but don't exist (a fabricated citation).
 *  - `ok`      — true only when the item cited >=1 id and *every* id is real.
 *
 * `empty` and `unknownIds` are reported independently rather than collapsed into
 * one boolean because the repair instruction differs: an empty item needs a
 * citation added (or the claim dropped), a bad-id item needs the id corrected.
 */
export interface ReferenceCheck {
  ok: boolean;
  unknownIds: string[];
  empty: boolean;
}

/**
 * Verify that a single item's `sources` all reference real artifact ids.
 *
 * @param sources  The ids this item cites (e.g. ["pr:42", "commit:abc"]).
 * @param validIds The set of ids that actually exist in the release input.
 *                 A `Set` (not an array) so each membership test is O(1) — this
 *                 runs once per item per generation, possibly inside a loop.
 */
export function verifyReferences(
  sources: string[],
  validIds: Set<string>,
): ReferenceCheck {
  // An item with no citations is ungrounded by definition. Treated as a distinct
  // failure mode from "cited but wrong" so the repair prompt can be specific.
  const empty = sources.length === 0;

  // Collect *which* ids are fabricated (not just whether any are) so the repair
  // instruction can name them — telling the model exactly what to fix is far
  // more effective than a generic "some citations were invalid".
  const unknownIds = sources.filter((id) => !validIds.has(id));

  return {
    // Supported == cited something AND nothing it cited was fabricated.
    ok: !empty && unknownIds.length === 0,
    unknownIds,
    empty,
  };
}

/**
 * One flagged item in a faithfulness report: its position in the original list
 * plus a human-readable reason. `index` (not the item itself) is carried so the
 * report stays small and the caller can map a flag back to its source item.
 */
export interface FlaggedItem {
  index: number;
  issue: string;
}

/**
 * Aggregate faithfulness over a batch of generated items.
 *
 *  - `totalItems`     — how many items were checked.
 *  - `supportedItems` — how many passed (cited >=1 real id, no fabrications).
 *  - `rate`           — supportedItems / totalItems; the headline metric.
 *  - `flagged`        — the unsupported items, each with the concrete reason.
 *
 * This shape is shared with the (future) semantic verifier so downstream
 * consumers — the in-loop repair trigger and the UI faithfulness gauge — read
 * one uniform report regardless of which verifier produced it.
 */
export interface FaithfulnessReport {
  totalItems: number;
  supportedItems: number;
  rate: number;
  flagged: FlaggedItem[];
}

/**
 * Verify a batch of items, producing a `FaithfulnessReport`.
 *
 * An item is flagged when its sources are empty OR reference any unknown id.
 * The `issue` string is built to be directly usable in a repair prompt: it
 * states the failure mode and, for fabricated ids, lists them by name.
 *
 * @param items    Objects exposing a `sources: string[]` field. Kept structural
 *                 (not the full artifact types) so this works for changelog
 *                 entries, note sections, and doc updates alike — every grounded
 *                 artifact in the contract has `sources`.
 * @param validIds The known-good id set for the release window.
 */
export function verifyItems(
  items: { sources: string[] }[],
  validIds: Set<string>,
): FaithfulnessReport {
  const flagged: FlaggedItem[] = [];

  items.forEach((item, index) => {
    const check = verifyReferences(item.sources, validIds);
    if (check.ok) return;

    // Build the most actionable reason available. Empty and unknown-id are not
    // mutually exclusive in principle, but empty implies no ids to be unknown,
    // so the order here is exhaustive.
    const issue = check.empty
      ? "cites no sources (ungrounded claim)"
      : `cites unknown source id(s): ${check.unknownIds.join(", ")}`;

    flagged.push({ index, issue });
  });

  const totalItems = items.length;
  const supportedItems = totalItems - flagged.length;

  return {
    totalItems,
    supportedItems,
    // Guard against divide-by-zero: an empty batch is vacuously fully supported
    // (rate 1), which is the right identity for the repair gate — "nothing to
    // generate" must not look like a faithfulness failure.
    rate: totalItems === 0 ? 1 : supportedItems / totalItems,
    flagged,
  };
}
