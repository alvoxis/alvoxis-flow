import path from "node:path";
import { defineConfig } from "vitest/config";

const shared = {
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside the React server runtime; tests run in plain Node.
      "server-only": path.resolve(import.meta.dirname, "tests/support/empty-module.ts"),
    },
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: { name: "unit", environment: "node", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        ...shared,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          // Tests share one database; run files sequentially.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
