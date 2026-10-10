import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "functions/**/*.test.ts",
      "infra/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    // IT は LocalStack の起動・デプロイが前提のため、vitest.it.config.ts（npm run test:it）でだけ動かす
    exclude: [...configDefaults.exclude, "test/it/**"],
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
