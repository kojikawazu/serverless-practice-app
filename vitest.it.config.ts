import { defineConfig } from "vitest/config";

// IT（LocalStack にデプロイした状態で実行を起動して確かめる）の設定。npm run test:it から使う。
// 前提（LocalStack の起動・デプロイ）が要り時間もかかるため、npm test・CI の対象には入れない（docs/08「テストツール・実行方法」）
export default defineConfig({
  test: {
    include: ["test/it/**/*.test.ts"],
    // ケースは LocalStack 上の同じキューを使うため、ファイルも並行に走らせない
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
