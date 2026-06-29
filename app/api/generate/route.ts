/**
 * POST /api/generate — run the release-documentation pipeline and return the
 * full `ReleasePackage` (changelog, internal/customer notes, doc updates, plus
 * the change set, plan, retrieval evidence, and pipeline trace).
 *
 * Offline this returns the deterministic extractive baseline; with
 * ANTHROPIC_API_KEY set it returns abstractive output — same response shape.
 * GET is supported too so the endpoint can be exercised from a browser.
 */

import { NextResponse } from "next/server";

import { runPipeline } from "@/lib/pipeline";

// The pipeline reads fixtures at request time; never statically prerender it.
export const dynamic = "force-dynamic";

async function generate() {
  const pkg = await runPipeline();
  return NextResponse.json(pkg);
}

export async function POST() {
  return generate();
}

export async function GET() {
  return generate();
}
