/**
 * Mock connectors / data-ingestion layer — the pipeline's only door to source data.
 *
 * Designed as a **port/adapter** (hexagonal) so the rest of the system depends on
 * an interface, never on where the bytes come from:
 *
 *  - `Connector` (the *port*) is the contract every downstream stage codes against.
 *    It deals only in schema-validated domain types from `@/lib/schemas`, so the
 *    Digester/Planner/etc. never see raw JSON or filesystem concerns.
 *  - `MockConnector` (the *adapter*) is the offline-first implementation: it reads
 *    the frozen, real-derived fixtures committed under `data/mocks/` and validates
 *    every file against the shared zod contract before handing it upstream.
 *
 * Why validate on read rather than trust the JSON: the fixtures are *harvested*
 * from a live OSS repo (see `data/README.md`) and regenerated wholesale by
 * `npm run harvest`. Parsing through the schemas turns "the harvest produced a
 * shape the pipeline can't consume" into a loud, located failure at ingestion
 * time instead of a silent `undefined` three agents downstream. It also applies
 * the schema defaults, so partial source records are normalized here, once.
 *
 * Offline-first guarantee: this module performs no network I/O. It resolves
 * `data/` relative to `process.cwd()` (the Next.js project root at runtime) and
 * only ever reads from the local filesystem.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CommitSchema,
  PullRequestSchema,
  TicketSchema,
  ReleaseRefSchema,
  ReleaseInputSchema,
  GroundTruthSchema,
  CuratedGoldSchema,
  type ReleaseInput,
  type GroundTruth,
  type CuratedGold,
} from "@/lib/schemas";

/* ============================================================================
 * Port: the contract downstream stages depend on.
 * ========================================================================== */

/** A single documentation file, ready for the RAG/retrieval stage to chunk. */
export interface LoadedDoc {
  /**
   * The **bare filename** (e.g. `tutorial__bigger-applications.md`), NOT a full
   * path. This is deliberate: `ground-truth.json` (`changedDocPaths`) and
   * `curated-gold.json` (`impactedDocs[].docPath`) both key documents by this
   * flattened name, so keeping `docPath` bare lets evaluation join on it directly.
   */
  docPath: string;
  text: string;
}

/**
 * The ingestion port. Implementations supply schema-validated source artifacts;
 * they must not leak transport details (paths, fetch, parsing) to callers.
 */
export interface Connector {
  /** The assembled, validated source bundle for the release window. */
  loadReleaseInput(): ReleaseInput;
  /** Every existing doc (the "before" state) as `{ docPath, text }`. */
  loadDocs(): LoadedDoc[];
}

/* ============================================================================
 * Adapter: MockConnector — reads & validates data/mocks/ from disk.
 * ========================================================================== */

/** Fixture layout under the project's `data/` directory. */
const DATA_DIR = "data";
const MOCKS_DIR = join(DATA_DIR, "mocks");
const DOCS_DIR = join(MOCKS_DIR, "docs");

export class MockConnector implements Connector {
  /**
   * @param rootDir Project root that contains `data/`. Defaults to
   *   `process.cwd()` so the same connector works under `next dev`, `next build`,
   *   and `vitest` (all run from the project root) without configuration.
   */
  constructor(private readonly rootDir: string = process.cwd()) {}

  /** Read a JSON fixture and parse it through a per-element zod schema. */
  private readJsonArray<T>(
    relativePath: string,
    schema: { parse(value: unknown): T },
  ): T[] {
    const raw = this.readJson(relativePath);
    if (!Array.isArray(raw)) {
      // A clear error here beats a confusing `.map of undefined` later.
      throw new Error(
        `Expected a JSON array in ${relativePath}, got ${typeof raw}`,
      );
    }
    // Validate element-by-element: a bad record names its own file, and the
    // schema's defaults are applied uniformly to every item.
    return raw.map((item) => schema.parse(item));
  }

  /** Read and JSON.parse a single fixture file, resolved under the project root. */
  private readJson(relativePath: string): unknown {
    const text = readFileSync(join(this.rootDir, relativePath), "utf8");
    return JSON.parse(text);
  }

  /**
   * Assemble the release bundle from its four constituent fixtures, validating
   * each array per-element and the final object against `ReleaseInputSchema`.
   *
   * The bundle is split across files (commits/pulls/tickets/release) because
   * that mirrors how the data is actually sourced — separate GitHub/Jira
   * endpoints — and lets each be re-harvested independently.
   */
  loadReleaseInput(): ReleaseInput {
    const release = ReleaseRefSchema.parse(
      this.readJson(join(MOCKS_DIR, "release.json")),
    );
    const commits = this.readJsonArray(
      join(MOCKS_DIR, "commits.json"),
      CommitSchema,
    );
    const pullRequests = this.readJsonArray(
      join(MOCKS_DIR, "pulls.json"),
      PullRequestSchema,
    );
    const tickets = this.readJsonArray(
      join(MOCKS_DIR, "tickets.json"),
      TicketSchema,
    );

    // Re-validate the assembled whole so callers get a value already proven to
    // satisfy the inter-agent contract, not just four independently-valid parts.
    return ReleaseInputSchema.parse({
      release,
      commits,
      pullRequests,
      tickets,
    });
  }

  /**
   * Load every `data/mocks/docs/*.md` as `{ docPath, text }`, where `docPath`
   * is the bare filename so it joins directly against the eval gold sets.
   *
   * Results are sorted by filename for deterministic ordering across machines
   * (`readdirSync` order is platform-dependent), which keeps tests and any
   * downstream chunk ids stable.
   */
  loadDocs(): LoadedDoc[] {
    const dir = join(this.rootDir, DOCS_DIR);
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({
        docPath: name,
        text: readFileSync(join(dir, name), "utf8"),
      }));
  }

  /**
   * The auto-generated eval signals (release-note PRs/categories + the weak
   * `changedDocPaths` proxy). Validated so the eval suite can trust the shape.
   */
  loadGroundTruth(): GroundTruth {
    return GroundTruthSchema.parse(
      this.readJson(join(MOCKS_DIR, "ground-truth.json")),
    );
  }

  /**
   * The hand-curated PRIMARY doc-recommendation gold set. Lives *outside*
   * `mocks/` (at `data/curated-gold.json`) precisely so re-harvesting — which
   * regenerates `mocks/` wholesale — never clobbers the human-judged labels.
   */
  loadCuratedGold(): CuratedGold {
    return CuratedGoldSchema.parse(
      this.readJson(join(DATA_DIR, "curated-gold.json")),
    );
  }
}

/* ============================================================================
 * Pure helpers over a loaded ReleaseInput (no I/O — easy to unit-test).
 * ========================================================================== */

/**
 * Ids of pull requests and commits with NO linked ticket (empty `ticketKeys`).
 *
 * This is the **incomplete-information signal** the Digester surfaces (and the
 * Planner turns into ticket-coverage accounting): in the real FastAPI window
 * most PRs are translation/internal/chore work that was intentionally left
 * ticketless (see `data/README.md`), so an honest pipeline must show "we
 * couldn't tie these to intent" rather than silently inventing rationale.
 *
 * Returned in a stable order (PRs first, then commits, each in input order) so
 * the value is deterministic for snapshotting and UI display.
 */
export function findUnlinkedArtifactIds(input: ReleaseInput): string[] {
  const isUnlinked = (a: { ticketKeys: string[] }) => a.ticketKeys.length === 0;
  return [
    ...input.pullRequests.filter(isUnlinked).map((pr) => pr.id),
    ...input.commits.filter(isUnlinked).map((c) => c.id),
  ];
}
