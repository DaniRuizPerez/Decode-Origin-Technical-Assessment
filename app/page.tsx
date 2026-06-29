/**
 * Home page — the review/approve dashboard.
 *
 * WHY a SAMPLE package today: the pipeline and the `/api/generate` route land in
 * later waves. This page is the single data-source seam: it feeds the dashboard
 * a realistic, schema-validated `ReleasePackage` so the UI is fully reviewable
 * now. In Wave 3 the coordinator replaces `SAMPLE_PACKAGE` with a fetch from
 * `/api/generate` (e.g. make this an async server component) — the
 * `<Dashboard pkg={...} />` contract stays identical.
 */

import { Dashboard } from "@/components/Dashboard";
import { SAMPLE_PACKAGE } from "@/lib/sample/releasePackage";

export default function Home() {
  return <Dashboard pkg={SAMPLE_PACKAGE} />;
}
