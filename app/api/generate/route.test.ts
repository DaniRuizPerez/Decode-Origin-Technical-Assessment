// @vitest-environment node

/**
 * Route tests for /api/generate.
 *
 * The handlers run the full pipeline at request time. With no ANTHROPIC_API_KEY
 * the run resolves to the deterministic mock provider, so this is network-free.
 * We assert only the contract — the response body is a schema-valid
 * `ReleasePackage` — since the pipeline's content is exercised in lib tests.
 */

import { describe, it, expect } from "vitest";

import { GET, POST } from "./route";
import { ReleasePackageSchema } from "@/lib/schemas";

describe("/api/generate", () => {
  it("POST returns a schema-valid ReleasePackage", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ReleasePackageSchema.safeParse(body).success).toBe(true);
  });

  it("GET returns a schema-valid ReleasePackage", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ReleasePackageSchema.safeParse(body).success).toBe(true);
  });
});
