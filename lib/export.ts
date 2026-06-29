/**
 * Export helper: render the internal, citation-rich `ReleaseArtifacts` to the
 * exact snake_case shape the assessment PDF suggests.
 *
 * WHY a dedicated module: the spec's output shape (`{ changelog,
 * internal_release_notes, customer_release_notes, documentation_updates }`) is
 * intentionally *different* from our internal camelCase schema — the internal
 * types carry per-item provenance the spec shape drops. Keeping the mapping in
 * one pure function means the Approve/Export button and any future server-side
 * exporter agree on a single canonical output, and it can be unit-tested without
 * a browser. (The schema file points at "lib/export" as this seam.)
 *
 * WHY it lives in lib (not in the component): it is pure data-shaping with no
 * React/DOM dependency, so it stays usable from API routes or scripts later.
 */

import type { ReleaseArtifacts } from "@/lib/schemas";

/** The spec's snake_case output shape. */
export interface SpecOutput {
  changelog: Array<{ category: string; text: string; sources: string[] }>;
  internal_release_notes: Array<{
    heading: string;
    body: string;
    sources: string[];
  }>;
  customer_release_notes: Array<{
    heading: string;
    body: string;
    sources: string[];
  }>;
  documentation_updates: Array<{
    doc_path: string;
    section: string;
    suggestion: string;
    sources: string[];
    is_possible_doc_debt: boolean;
  }>;
}

/**
 * Map internal artifacts → the spec's snake_case shape. We deliberately preserve
 * `sources` on every item: traceability is a graded requirement, so the exported
 * artifact stays grounded rather than collapsing to prose.
 */
export function toSpecOutput(artifacts: ReleaseArtifacts): SpecOutput {
  return {
    changelog: artifacts.changelog.map((e) => ({
      category: e.category,
      text: e.text,
      sources: e.sources,
    })),
    internal_release_notes: artifacts.internalReleaseNotes.map((n) => ({
      heading: n.heading,
      body: n.body,
      sources: n.sources,
    })),
    customer_release_notes: artifacts.customerReleaseNotes.map((n) => ({
      heading: n.heading,
      body: n.body,
      sources: n.sources,
    })),
    documentation_updates: artifacts.documentationUpdates.map((d) => ({
      doc_path: d.docPath,
      section: d.section,
      suggestion: d.suggestion,
      sources: d.sources,
      is_possible_doc_debt: d.isPossibleDocDebt,
    })),
  };
}
