import { defineConfig } from "vitest/config";

// Each CI shard sees only part of the suite, so only full runs and the shard merge check thresholds.
const sharded = process.argv.some((argument) => argument.startsWith("--shard"));

// The most uncovered items production source may have: CI's merged counts plus a small allowance
// for run-to-run noise. Lower these when coverage improves; raising one needs a stated reason in the PR.
const maxUncovered = { statements: 139, branches: 250, functions: 47, lines: 85 };

export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "evals/src/**/*.test.ts",
      "evals/tasks/**/*.test.ts",
      "scripts/*.test.ts",
    ],
    globalSetup: ["./apps/cli/test/support/build-cli.ts"],
    testTimeout: 20_000,
    coverage: {
      // Production source, counted even when no test imports it.
      include: [
        "apps/*/src/**/*.{ts,tsx}",
        "apps/website/demo/**/*.ts",
        "packages/*/src/**/*.{ts,tsx}",
        "evals/src/**/*.ts",
      ],
      // Tests and the test helpers that live beside production source.
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.test-support.ts",
        "packages/reader/src/figures/*-fixtures.ts",
      ],
      reporter: ["text-summary"],
      thresholds: sharded
        ? undefined
        : {
            statements: -maxUncovered.statements,
            branches: -maxUncovered.branches,
            functions: -maxUncovered.functions,
            lines: -maxUncovered.lines,
          },
    },
  },
});
