import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "functions/**/*.test.ts",
      "infra/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      // カバレッジの対象は Lambda の実装のみ。infra/ は対象外（docs/08-test-specification.md）
      include: ["functions/src/**/*.ts"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
