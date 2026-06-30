import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for the App Router route tests under `app/`.
 *
 * WHY a separate file: the primary `vitest.config.ts` scopes `include` to
 * `lib/**` and `scripts/**` (the unit-test surface). The API route handlers live
 * under `app/api/**`; rather than widen the shared config, this dedicated config
 * targets the route tests. Run with:
 *
 *   npx vitest run --config vitest.config.app.ts
 */
export default defineConfig({
  // Mirror tsconfig's `"@/*": ["./*"]` alias so `@/lib/...` resolves as it does
  // under tsc / Next.js.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    testTimeout: 30_000,
  },
});
