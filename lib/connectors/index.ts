/**
 * Public API of the ingestion layer.
 *
 * Downstream code should import from `@/lib/connectors` and call `getConnector()`
 * rather than constructing an adapter directly — that keeps the choice of source
 * (today: the offline `MockConnector`) a single swap-point. When a real
 * GitHub/Jira-backed connector exists, only this factory changes.
 */

import { MockConnector, type Connector } from "./connector";

export type { Connector, LoadedDoc } from "./connector";
export { MockConnector, findUnlinkedArtifactIds } from "./connector";

/**
 * The connector the app runs with. Offline-first by default: returns a
 * `MockConnector` reading the frozen fixtures under `data/mocks/`.
 *
 * Typed as the narrow `Connector` port on purpose, so callers can't accidentally
 * couple to `MockConnector`-only methods through this entry point.
 */
export function getConnector(): Connector {
  return new MockConnector();
}

/**
 * Loaders for the evaluation reference data. These are deliberately *not* on the
 * `Connector` port: ground truth / curated gold are consumed only by the eval
 * suite, not by the generation pipeline, so they stay off the runtime contract.
 * Exposed as thin helpers for convenience and to centralize fixture resolution.
 */
export function loadGroundTruth() {
  return new MockConnector().loadGroundTruth();
}

export function loadCuratedGold() {
  return new MockConnector().loadCuratedGold();
}
