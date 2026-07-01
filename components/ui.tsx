/**
 * Small, purely presentational UI primitives shared across the dashboard.
 *
 * WHY grouped in one file: these are tiny, stateless, and tightly related, so
 * keeping them together avoids a sprawl of one-line files while staying
 * server-component-safe (no hooks, no event handlers) — they render on the server
 * inside either client or server parents.
 */

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
