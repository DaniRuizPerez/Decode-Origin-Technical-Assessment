import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror tsconfig's `"@/*": ["./*"]` path alias so runtime imports of
  // `@/lib/...` resolve under vitest exactly as they do under tsc/Next.js.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Test surface: lib + scripts, plus the App Router API route tests under
    // app/ (route handlers are plain Request→Response functions; their files
    // declare `// @vitest-environment node` so they're explicit either way).
    include: [
      "lib/**/*.test.ts",
      "scripts/**/*.test.ts",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
    ],
    testTimeout: 30_000,
  },
});
