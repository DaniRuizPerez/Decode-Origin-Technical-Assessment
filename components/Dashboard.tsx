"use client";

/**
 * Dashboard — the presentational composition of the whole review/approve UI.
 *
 * WHY this component owns state (and the leaf panels don't): editing one field
 * and exporting the result requires a single source of truth for the *current
 * draft*. The dashboard holds an editable copy of `pkg.artifacts` and passes
 * down values + typed onEdit callbacks; the Review bar exports that same draft.
 * Leaf panels stay dumb (value in, change-event out), which keeps them testable
 * and lets the coordinator later feed `pkg` from `/api/generate` with zero
 * changes to this file — only `app/page.tsx` swaps the data source.
 *
 * WHY a client component: it holds React state (edit mode + the draft) and wires
 * interactivity. `pkg` itself is plain serializable data, so it can be produced
 * on the server (the sample today, the API tomorrow) and handed in as a prop.
 */

import { useState } from "react";
import type { ReleasePackage, ReleaseArtifacts } from "@/lib/schemas";
import { ReleaseHeader } from "./ReleaseHeader";
import { ChangelogList } from "./ChangelogList";
import { NotesSections } from "./NotesSections";
import { DocumentationUpdates } from "./DocumentationUpdates";
import { PipelineTrace } from "./PipelineTrace";
import { ReviewBar } from "./ReviewBar";
import { SourceIndexProvider } from "./SourceIndexContext";

export function Dashboard({ pkg }: { pkg: ReleasePackage }) {
  const [editing, setEditing] = useState(false);
  // The editable draft. Initialized from the incoming package; only the
  // free-text fields are mutated. WHY a deep-ish copy via map: we must not
  // mutate the prop, and React needs new array/object identities to re-render.
  const [artifacts, setArtifacts] = useState<ReleaseArtifacts>(() => ({
    changelog: pkg.artifacts.changelog.map((e) => ({ ...e })),
    internalReleaseNotes: pkg.artifacts.internalReleaseNotes.map((n) => ({ ...n })),
    customerReleaseNotes: pkg.artifacts.customerReleaseNotes.map((n) => ({ ...n })),
    documentationUpdates: pkg.artifacts.documentationUpdates.map((d) => ({ ...d })),
  }));
  // Track whether the reviewer changed anything, purely to show an "edited" hint.
  const [dirty, setDirty] = useState(false);

  /* Typed, immutable field updaters. Each replaces exactly one item's one text
   * field and leaves provenance (`sources`) untouched — editing copy must never
   * silently drop the evidence that grounds it. */

  function editChangelogText(index: number, text: string) {
    setArtifacts((prev) => ({
      ...prev,
      changelog: prev.changelog.map((e, i) => (i === index ? { ...e, text } : e)),
    }));
    setDirty(true);
  }

  function editInternalBody(index: number, body: string) {
    setArtifacts((prev) => ({
      ...prev,
      internalReleaseNotes: prev.internalReleaseNotes.map((n, i) =>
        i === index ? { ...n, body } : n,
      ),
    }));
    setDirty(true);
  }

  function editCustomerBody(index: number, body: string) {
    setArtifacts((prev) => ({
      ...prev,
      customerReleaseNotes: prev.customerReleaseNotes.map((n, i) =>
        i === index ? { ...n, body } : n,
      ),
    }));
    setDirty(true);
  }

  function editDocSuggestion(index: number, suggestion: string) {
    setArtifacts((prev) => ({
      ...prev,
      documentationUpdates: prev.documentationUpdates.map((d, i) =>
        i === index ? { ...d, suggestion } : d,
      ),
    }));
    setDirty(true);
  }

  return (
    <SourceIndexProvider value={pkg.sourceIndex}>
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <ReviewBar
          release={pkg.release}
          artifacts={artifacts}
          editing={editing}
          onToggleEdit={() => setEditing((v) => !v)}
          dirty={dirty}
        />

        <div className="space-y-6">
          <ReleaseHeader pkg={pkg} />

          <ChangelogList
            entries={artifacts.changelog}
            editing={editing}
            onEditText={editChangelogText}
          />

          <NotesSections
            internal={artifacts.internalReleaseNotes}
            customer={artifacts.customerReleaseNotes}
            editing={editing}
            onEditInternal={editInternalBody}
            onEditCustomer={editCustomerBody}
          />

          <DocumentationUpdates
            updates={artifacts.documentationUpdates}
            retrieval={pkg.retrieval}
            editing={editing}
            onEditSuggestion={editDocSuggestion}
          />

          <PipelineTrace trace={pkg.trace} />
        </div>
      </main>
    </SourceIndexProvider>
  );
}
