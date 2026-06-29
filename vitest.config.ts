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
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
