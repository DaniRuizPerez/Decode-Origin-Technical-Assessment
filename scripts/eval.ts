/**
 * `npm run eval` entrypoint — a thin wrapper around `lib/eval`.
 *
 * All logic lives in `lib/eval/run.ts` (importable + unit-tested); this file just
 * invokes it and maps the returned code to the process exit status. Kept tiny on
 * purpose so the evaluation framework owns its own behaviour.
 */

import { main } from "@/lib/eval";

process.exit(main(process.argv));
