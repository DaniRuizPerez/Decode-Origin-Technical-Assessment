/**
 * Home page — the review/approve dashboard, now backed by the REAL pipeline.
 *
 * This is an async Server Component: it runs the pipeline on the server at
 * request time and passes the resulting `ReleasePackage` to the (client)
 * Dashboard. Offline that's the deterministic extractive baseline over the real
 * FastAPI fixtures; with ANTHROPIC_API_KEY set it's abstractive output — the
 * `<Dashboard pkg={...} />` contract is identical either way.
 *
 * `force-dynamic` so the pipeline runs per request (it reads fixtures from disk)
 * rather than being prerendered at build time.
 */

import { Dashboard } from "@/components/Dashboard";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export default async function Home() {
  const pkg = await runPipeline();
  return <Dashboard pkg={pkg} />;
}
