import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "packages/config/src/**/*.ts",
        "packages/core/src/**/*.ts",
        "packages/mcp/src/**/*.ts",
        "packages/renderer/src/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/index.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "install/**/*.test.ts",
    ],
    environment: "node",
    setupFiles: ["apps/web/vitest.setup.ts"],
  },
});
