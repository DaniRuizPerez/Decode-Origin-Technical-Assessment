/**
 * POST /api/approve — finalize a (possibly human-edited) release package.
 *
 * The reviewer edits artifacts in the UI, then approves. We re-validate the
 * submitted package against the contract (so edits can't produce an invalid
 * package), stamp the approval, and return both the approved package and the
 * `documentation_updates`-style **spec-shape** export (snake_case keys the PDF
 * suggests) ready to ship to downstream consumers.
 *
 * Body: a `ReleasePackage` (optionally wrapped as `{ package: ... }`).
 */

import { NextResponse } from "next/server";

import { ReleasePackageSchema } from "@/lib/schemas";
import { toSpecOutput } from "@/lib/export";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept either the bare package or `{ package: ... }`.
  const candidate =
    body && typeof body === "object" && "package" in body
      ? (body as { package: unknown }).package
      : body;

  const parsed = ReleasePackageSchema.safeParse(candidate);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Package failed schema validation", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const approved = {
    ...parsed.data,
    approval: { approved: true, approvedAt: new Date().toISOString() },
  };

  return NextResponse.json({
    approved,
    specOutput: toSpecOutput(approved.artifacts),
  });
}
