"use client";

/**
 * Internal vs Customer release notes, rendered as two clearly distinct panels.
 *
 * WHY a hard visual split: the two audiences are different (maintainers vs
 * end-users) and leaking internal risk/migration detail into customer notes is a
 * real failure mode. Distinct accent colours + an explicit audience label make
 * the boundary obvious to a reviewer. Editing binds each section body to the
 * dashboard's draft state, so it is a client component.
 */

import type { NoteSection } from "@/lib/schemas";
import { SourceEvidence } from "./SourceEvidence";
import { Panel } from "./ui";

/** Which audience a column targets — drives the accent + the `audience` prop. */
type Audience = "internal" | "customer";

const ACCENT: Record<Audience, { bar: string; chip: string; label: string }> = {
  internal: {
    bar: "border-l-amber-400",
    chip: "bg-amber-100 text-amber-800 ring-amber-600/20",
    label: "Internal · maintainers",
  },
  customer: {
    bar: "border-l-sky-400",
    chip: "bg-sky-100 text-sky-800 ring-sky-600/20",
    label: "Customer · end-users",
  },
};

function NotesColumn({
  audience,
  title,
  sections,
  editing,
  onEditBody,
}: {
  audience: Audience;
  title: string;
  sections: NoteSection[];
  editing: boolean;
  onEditBody: (index: number, body: string) => void;
}) {
  const accent = ACCENT[audience];
  return (
    <Panel title={title}>
      <span
        className={`mb-3 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${accent.chip}`}
      >
        {accent.label}
      </span>
      <div className="space-y-4">
        {sections.map((section, index) => (
          <article
            key={index}
            className={`border-l-2 pl-3 ${accent.bar}`}
          >
            <h3 className="text-sm font-semibold text-gray-900">
              {section.heading}
            </h3>
            {editing ? (
              <textarea
                value={section.body}
                onChange={(e) => onEditBody(index, e.target.value)}
                rows={3}
                className="mt-1 w-full resize-y rounded-md border border-indigo-200 bg-white p-2 text-sm text-gray-800 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                aria-label={`Edit ${audience} note: ${section.heading}`}
              />
            ) : (
              <p className="mt-1 text-sm leading-relaxed text-gray-700">
                {section.body}
              </p>
            )}
            {section.sources.length > 0 ? (
              <div className="mt-2">
                <SourceEvidence sources={section.sources} />
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </Panel>
  );
}

export function NotesSections({
  internal,
  customer,
  editing,
  onEditInternal,
  onEditCustomer,
}: {
  internal: NoteSection[];
  customer: NoteSection[];
  editing: boolean;
  onEditInternal: (index: number, body: string) => void;
  onEditCustomer: (index: number, body: string) => void;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <NotesColumn
        audience="internal"
        title="Internal release notes"
        sections={internal}
        editing={editing}
        onEditBody={onEditInternal}
      />
      <NotesColumn
        audience="customer"
        title="Customer release notes"
        sections={customer}
        editing={editing}
        onEditBody={onEditCustomer}
      />
    </div>
  );
}
