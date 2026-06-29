/**
 * Planner agent — the second "understanding" stage of the pipeline.
 *
 * Input: the Digester's `ChangeSet` + the raw `ReleaseInput`.
 * Output: a `ReleasePlan` — themes, affected systems, *explainable* risk, and
 * ticket-coverage accounting.
 *
 * DESIGN: hybrid extractive-baseline + LLM enrichment, same as the Digester.
 *
 *   1. A deterministic pass computes everything structurally from the changes:
 *      it groups them into themes, unions their components into affected systems,
 *      derives a risk level from concrete signals (each with a human-readable
 *      reason), and accounts ticket coverage against `input.tickets`.
 *   2. That baseline is the `fallback`. Offline (MockProvider) it is returned
 *      verbatim — so it must be genuinely good. Online (Anthropic) the model may
 *      rewrite theme titles/summaries and risk prose.
 *
 * WHY a plain `provider.complete` here (no `groundedGenerate`): the plan's
 * citations are *structural* — themes reference `changeIds` and coverage lists
 * ticket keys, both of which are validated by `ReleasePlanSchema` and checked
 * against the known change/ticket sets. There are no free-form `sources[]` to
 * verify against the artifact id space, so the in-loop citation verifier (which
 * the Digester/Writer need) does not apply.
 */

import {
  ReleasePlanSchema,
  type Change,
  type ChangeSet,
  type LLMProvider,
  type ReleaseInput,
  type ReleasePlan,
  type Risk,
  type Theme,
  type TicketCoverage,
} from "@/lib/schemas";

/* ============================================================================
 * Risk signals — concrete, explainable inputs to the risk level.
 *
 * Each signal is deterministic and produces a human-readable reason string, so
 * the resulting risk is auditable ("why is this high?") rather than an opaque
 * score. The spec calls for exactly this: a level PLUS the reasons that produced
 * it.
 * ========================================================================== */

/** Components whose names imply a security-/auth-sensitive surface. */
const SECURITY_COMPONENT_HINTS = [
  "security",
  "auth",
  "oauth",
  "oauth2",
  "jwt",
  "crypto",
  "password",
];

/** A component (or change summary) that signals a security-sensitive area. */
function isSecuritySensitive(change: Change): boolean {
  if (change.type === "security") return true;
  const hay = [...change.components, change.summary].join(" ").toLowerCase();
  return SECURITY_COMPONENT_HINTS.some((h) => hay.includes(h));
}

/**
 * Breadth threshold: touching this many distinct components in one release is
 * itself a risk signal (a wide blast radius), independent of any single change.
 */
const BROAD_COMPONENT_THRESHOLD = 5;

/**
 * Compute explainable risk from the change set.
 *
 * Level rules (highest wins):
 *  - HIGH   if any change is breaking.
 *  - HIGH   if a security-sensitive area changed AND breadth is wide.
 *  - MEDIUM if any of: security-sensitive change, dependency upgrade, multiple
 *           fixes clustered on one component (rough-edges signal), or wide breadth.
 *  - LOW    otherwise.
 *
 * Every contributing signal appends a reason, so `reasons` always explains the
 * level. WHY derive both level and reasons from the same pass: it guarantees the
 * explanation can never drift from the verdict.
 */
function assessRisk(changes: Change[]): Risk {
  const reasons: string[] = [];

  const breaking = changes.filter((c) => c.isBreaking);
  const security = changes.filter(isSecuritySensitive);
  const deps = changes.filter((c) => c.type === "deps");
  const fixes = changes.filter((c) => c.type === "fix");

  // Blast radius: how many distinct components the release touches.
  const components = new Set<string>();
  for (const c of changes) for (const comp of c.components) components.add(comp);
  const broad = components.size >= BROAD_COMPONENT_THRESHOLD;

  // --- Build reasons for whichever signals fired ---------------------------
  for (const c of breaking) {
    // Name the concrete artifact so a reviewer can open it.
    const ref = primarySourceRef(c);
    reasons.push(
      `Breaking change: "${c.summary}"${ref ? ` (${ref})` : ""} — affects a core API; downstream code may need migration.`,
    );
  }

  // Clustered fixes on a single component often mean a recent change shipped
  // with rough edges. Surfaced as a reason because it raises rollout risk.
  const fixesByComponent = clusterFixesByComponent(fixes);
  for (const [component, group] of fixesByComponent) {
    if (group.length >= 2) {
      reasons.push(
        `${group.length} fixes clustered in "${component}" (${group
          .map((c) => primarySourceRef(c))
          .filter(Boolean)
          .join(", ")}) suggest a recently-changed area shipped with rough edges.`,
      );
    }
  }

  for (const c of security) {
    reasons.push(
      `Security-/auth-sensitive change: "${c.summary}" — review the impact on input validation and access control.`,
    );
  }

  if (deps.length > 0) {
    reasons.push(
      `${deps.length} dependency/upgrade change(s) (e.g. ${deps
        .map((c) => primarySourceRef(c))
        .filter(Boolean)
        .slice(0, 3)
        .join(", ")}) can shift transitive behavior.`,
    );
  }

  if (broad) {
    reasons.push(
      `Wide blast radius: ${components.size} components touched (${[...components]
        .slice(0, 6)
        .join(", ")}${components.size > 6 ? ", …" : ""}).`,
    );
  }

  // --- Decide the level from the signals -----------------------------------
  let level: Risk["level"];
  if (breaking.length > 0) {
    level = "high";
  } else if (security.length > 0 && broad) {
    level = "high";
  } else if (
    security.length > 0 ||
    deps.length > 0 ||
    broad ||
    [...fixesByComponent.values()].some((g) => g.length >= 2)
  ) {
    level = "medium";
  } else {
    level = "low";
  }

  // Guarantee a non-empty explanation even for a quiet, low-risk release.
  if (reasons.length === 0) {
    reasons.push(
      "No breaking, security, dependency, or broad-impact signals detected; routine release.",
    );
  }

  return { level, reasons };
}

/** Group fix-type changes by their first component, for the rough-edges signal. */
function clusterFixesByComponent(fixes: Change[]): Map<string, Change[]> {
  const byComponent = new Map<string, Change[]>();
  for (const fix of fixes) {
    // Use the primary (first) component; an uncomponented fix can't cluster.
    const key = fix.components[0];
    if (!key) continue;
    const list = byComponent.get(key) ?? [];
    list.push(fix);
    byComponent.set(key, list);
  }
  return byComponent;
}

/**
 * A short human reference for a change — its PR id if present, else the first
 * source id. Used only to make risk reasons concrete (they are prose, not
 * verified citations), so a best-effort reference is enough.
 */
function primarySourceRef(change: Change): string {
  const pr = change.sourceIds.find((s) => s.startsWith("pr:"));
  return pr ?? change.sourceIds[0] ?? "";
}

/* ============================================================================
 * Theming — group changes into reviewer-facing themes.
 * ========================================================================== */

/**
 * Group changes into themes by their primary component, with breaking changes
 * pulled into their own lead theme.
 *
 * WHY component-first: a release reader thinks in terms of "what part of the
 * system changed" (routing, responses, deps), and grouping by the primary
 * component yields exactly those buckets from real data. Breaking changes get a
 * dedicated theme so the most consequential work leads the plan.
 *
 * Changes with no component (e.g. the collapsed internal-noise entry) fall into
 * a catch-all "Maintenance" theme rather than being dropped, so every change id
 * is represented in some theme.
 */
function buildThemes(changes: Change[]): Theme[] {
  const themes: Theme[] = [];

  // 1) Breaking changes lead, in their own theme.
  const breaking = changes.filter((c) => c.isBreaking);
  if (breaking.length > 0) {
    themes.push({
      title: "Breaking changes",
      summary: summarizeGroup(breaking),
      changeIds: breaking.map((c) => c.id),
    });
  }

  // 2) Remaining changes grouped by primary component.
  const remaining = changes.filter((c) => !c.isBreaking);
  const byComponent = new Map<string, Change[]>();
  const uncomponented: Change[] = [];
  for (const c of remaining) {
    const key = c.components[0];
    if (!key) {
      uncomponented.push(c);
      continue;
    }
    const list = byComponent.get(key) ?? [];
    list.push(c);
    byComponent.set(key, list);
  }

  // Deterministic ordering: components by descending group size, then name, so
  // the most active area leads and the output is stable across runs.
  const sorted = [...byComponent.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  for (const [component, group] of sorted) {
    themes.push({
      title: themeTitleFor(component),
      summary: summarizeGroup(group),
      changeIds: group.map((c) => c.id),
    });
  }

  // 3) Catch-all so no change id is orphaned (e.g. the noise summary).
  if (uncomponented.length > 0) {
    themes.push({
      title: "Maintenance",
      summary: summarizeGroup(uncomponented),
      changeIds: uncomponented.map((c) => c.id),
    });
  }

  return themes;
}

/** A readable theme title for a component (e.g. "routing" → "Routing"). */
function themeTitleFor(component: string): string {
  return component.charAt(0).toUpperCase() + component.slice(1);
}

/**
 * A one-line theme summary built deterministically from its changes: a count by
 * type plus the lead change's summary, so the theme reads informatively even
 * offline (no LLM). Kept short — the writer/UI expand on it later.
 */
function summarizeGroup(changes: Change[]): string {
  const lead = changes[0];
  if (changes.length === 1) return lead.summary;
  const typeCounts = new Map<string, number>();
  for (const c of changes) {
    typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
  }
  const breakdown = [...typeCounts.entries()]
    .map(([type, n]) => `${n} ${type}`)
    .join(", ");
  return `${changes.length} changes (${breakdown}); e.g. ${lead.summary}.`;
}

/* ============================================================================
 * Affected systems + ticket coverage.
 * ========================================================================== */

/** The union of all components touched, in first-seen order (stable). */
function unionComponents(changes: Change[]): string[] {
  const seen = new Set<string>();
  for (const c of changes) for (const comp of c.components) seen.add(comp);
  return [...seen];
}

/**
 * Account ticket coverage: how many of the release's tickets are cited by some
 * change's `sourceIds`.
 *
 * WHY this matters: it is one of the spec's eval metrics and the honest
 * incomplete-information signal. A ticket whose id appears in no change's
 * provenance is "uncovered" — its intent didn't make it into the change set —
 * and is listed in `missingTicketKeys` rather than silently ignored.
 */
function computeCoverage(
  changeSet: ChangeSet,
  input: ReleaseInput,
): TicketCoverage {
  // Every source id cited anywhere in the change set.
  const citedIds = new Set<string>();
  for (const change of changeSet.changes) {
    for (const id of change.sourceIds) citedIds.add(id);
  }

  const missingTicketKeys: string[] = [];
  let covered = 0;
  for (const ticket of input.tickets) {
    if (citedIds.has(ticket.id)) covered += 1;
    else missingTicketKeys.push(ticket.key);
  }

  return { total: input.tickets.length, covered, missingTicketKeys };
}

/* ============================================================================
 * Deterministic baseline construction.
 * ========================================================================== */

/** Build the deterministic, structural `ReleasePlan` from the change set. */
export function buildDeterministicPlan(
  changeSet: ChangeSet,
  input: ReleaseInput,
): ReleasePlan {
  const { changes } = changeSet;
  return ReleasePlanSchema.parse({
    themes: buildThemes(changes),
    affectedSystems: unionComponents(changes),
    risk: assessRisk(changes),
    coverage: computeCoverage(changeSet, input),
  });
}

/* ============================================================================
 * Prompt construction for the LLM enrichment pass.
 * ========================================================================== */

const PLANNER_SYSTEM = [
  "You are a release manager producing a release plan from a normalized change set.",
  "You are given a deterministic draft plan (themes, affected systems, explainable",
  "risk, ticket coverage). Improve the wording: write sharper theme titles/summaries",
  "and clearer risk reasons.",
  "",
  "HARD RULES:",
  "- Themes may ONLY reference changeIds that appear in the draft. Never invent one.",
  "- Do NOT change the risk LEVEL or the coverage NUMBERS — those are computed",
  "  deterministically from evidence; you may only reword the risk reasons.",
  "- Return the full ReleasePlan JSON matching the provided schema.",
].join("\n");

/** Build the enrichment prompt: hand the model the draft plan + change context. */
function buildPlannerPrompt(plan: ReleasePlan, changeSet: ChangeSet): string {
  // A compact change index so the model can write better theme prose without
  // re-deriving anything structural.
  const changeIndex = changeSet.changes.map((c) => ({
    id: c.id,
    type: c.type,
    summary: c.summary,
    components: c.components,
    isBreaking: c.isBreaking,
  }));

  return [
    "Deterministic draft plan (preserve structure, level, and coverage numbers):",
    "",
    JSON.stringify(plan, null, 2),
    "",
    "Change index (for context only — reference these ids in themes):",
    "",
    JSON.stringify(changeIndex, null, 2),
  ].join("\n");
}

/* ============================================================================
 * Public entry point.
 * ========================================================================== */

/**
 * Produce a `ReleasePlan` from the Digester's change set.
 *
 * Builds the deterministic, explainable baseline then runs it through the
 * provider: offline the faithful baseline is returned verbatim; online the LLM
 * may improve the prose while the schema keeps the structure valid.
 *
 * @param changeSet The Digester output (normalized, grounded changes).
 * @param input     The raw release input (for ticket-coverage accounting).
 * @param provider  The AI boundary (MockProvider offline, AnthropicProvider live).
 */
export async function plan(
  changeSet: ChangeSet,
  input: ReleaseInput,
  provider: LLMProvider,
): Promise<ReleasePlan> {
  const deterministic = buildDeterministicPlan(changeSet, input);

  const { value } = await provider.complete<ReleasePlan>({
    agent: "planner",
    system: PLANNER_SYSTEM,
    prompt: buildPlannerPrompt(deterministic, changeSet),
    schema: ReleasePlanSchema,
    fallback: deterministic,
  });

  return value;
}
