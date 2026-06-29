/**
 * Small, purely presentational UI primitives shared across the dashboard.
 *
 * WHY grouped in one file: these are tiny, stateless, and tightly related
 * (badges + meters). Keeping them together avoids a sprawl of one-line files
 * while staying server-component-safe (no hooks, no event handlers), so they can
 * render on the server inside either client or server parents.
 */

import type { Risk } from "@/lib/schemas";

/** Tailwind classes per risk level. Centralised so the palette stays consistent. */
const RISK_STYLES: Record<Risk["level"], string> = {
  low: "bg-emerald-100 text-emerald-800 ring-emerald-600/20",
  medium: "bg-amber-100 text-amber-800 ring-amber-600/20",
  high: "bg-rose-100 text-rose-800 ring-rose-600/20",
};

/** A coloured risk pill (level only — reasons are rendered by the header). */
export function RiskBadge({ level }: { level: Risk["level"] }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset ${RISK_STYLES[level]}`}
    >
      {/* dot reinforces severity without relying on colour alone */}
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {level} risk
    </span>
  );
}

/** Amber pill flagging a documentation suggestion that targets an untouched doc. */
export function DocDebtBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      possible doc debt
    </span>
  );
}

/**
 * A labelled 0..1 meter used for confidence and coverage. WHY a shared meter:
 * both the header's coverage stat and per-change confidence are normalized 0..1
 * values, so one accessible bar keeps them visually consistent.
 */
export function Meter({
  label,
  value,
  max = 1,
  tone = "indigo",
}: {
  label: string;
  /** Numerator. For coverage pass `covered`; for confidence pass the 0..1 value. */
  value: number;
  /** Denominator; defaults to 1 for a fraction. */
  max?: number;
  tone?: "indigo" | "emerald" | "amber";
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const bar =
    tone === "emerald"
      ? "bg-emerald-500"
      : tone === "amber"
        ? "bg-amber-500"
        : "bg-indigo-500";
  return (
    <div className="min-w-[8rem]">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-gray-600">{label}</span>
        <span className="tabular-nums text-gray-500">{pct}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** A neutral monospace chip used for artifact ids and doc paths. */
export function CodeChip({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 ring-1 ring-inset ring-gray-300">
      {children}
    </code>
  );
}

/** A simple section card wrapper to keep panels visually consistent. */
export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <header className="mb-4">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}
