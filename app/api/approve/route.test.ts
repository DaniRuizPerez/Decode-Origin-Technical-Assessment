// @vitest-environment node

/**
 * Route tests for POST /api/approve.
 *
 * We call the handler directly with a real `Request` (App Router route handlers
 * are just functions of `Request` → `Response`), so no running server is needed.
 * The valid-package case loads the committed baseline sample read-only to avoid
 * drift from the real pipeline output shape.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { POST } from "./route";

const baselinePath = fileURLToPath(
  new URL("../../../data/samples/baseline-release-package.json", import.meta.url),
);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as unknown;

/** Build a POST Request whose body is `body` (string passed through verbatim). */
function approveRequest(body: string): Request {
  return new Request("http://localhost/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/approve", () => {
  it("returns 200 with a stamped approval and a snake_case specOutput for a valid package", async () => {
    const res = await POST(approveRequest(JSON.stringify(baseline)));
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      approved: { approval: { approved: boolean; approvedAt: string | null } };
      specOutput: Record<string, unknown>;
    };

    // The server stamped the approval.
    expect(data.approved.approval.approved).toBe(true);
    expect(data.approved.approval.approvedAt).toBeTruthy();

    // The export is in the spec's snake_case shape.
    expect(Object.keys(data.specOutput).sort()).toEqual(
      [
        "changelog",
        "customer_release_notes",
        "documentation_updates",
        "internal_release_notes",
      ].sort(),
    );
  });

  it("accepts a package wrapped as { package: ... }", async () => {
    const res = await POST(approveRequest(JSON.stringify({ package: baseline })));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { approved: { approval: { approved: boolean } } };
    expect(data.approved.approval.approved).toBe(true);
  });

  it("returns 400 on an invalid JSON body", async () => {
    const res = await POST(approveRequest("this is not json"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBeTruthy();
  });

  it("returns 422 with issues for a schema-invalid package", async () => {
    // Missing the required changeSet/plan/artifacts (and a complete release ref).
    const res = await POST(approveRequest(JSON.stringify({ release: { project: "x" } })));
    expect(res.status).toBe(422);
    const data = (await res.json()) as { error?: string; issues?: unknown[] };
    expect(Array.isArray(data.issues)).toBe(true);
    expect((data.issues as unknown[]).length).toBeGreaterThan(0);
  });
});
