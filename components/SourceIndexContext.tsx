"use client";

/**
 * Source-index context — carries the package's resolved citations
 * (`Record<id, SourceRef>`) down to wherever evidence is rendered.
 *
 * WHY a context (not props): `SourceEvidence` is rendered deep inside three
 * independent leaf panels (ChangelogList / NotesSections / DocumentationUpdates),
 * each several levels below the Dashboard. Threading the index through every one
 * as a prop would touch every intermediate component for data they don't use.
 * A context lets the Dashboard provide it once and the leaf chip read it
 * directly via {@link useSourceIndex}.
 *
 * The default is an empty map so any consumer rendered WITHOUT a provider (or a
 * package that predates `sourceIndex`) simply finds nothing and degrades to the
 * id-only chip — no crash, no required wiring.
 */

import { createContext, useContext } from "react";
import type { SourceRef } from "@/lib/schemas";

const SourceIndexContext = createContext<Record<string, SourceRef>>({});

export function SourceIndexProvider({
  value,
  children,
}: {
  value: Record<string, SourceRef>;
  children: React.ReactNode;
}) {
  return (
    <SourceIndexContext.Provider value={value}>
      {children}
    </SourceIndexContext.Provider>
  );
}

/** Read the resolved citation index. Returns `{}` when no provider is mounted. */
export function useSourceIndex(): Record<string, SourceRef> {
  return useContext(SourceIndexContext);
}
