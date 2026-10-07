---
description: コーディング規約
globs: 
---

# コーディング規約

- **言語**: TypeScript strict モード（`strict: true`）
- **パッケージマネージャ**: npm を使用（pnpm, yarn は使用しない）
- **Linter / Formatter**: ESLint + Prettier でコード品質を担保
- **環境変数**: 設定値は環境変数で管理（.env）
- **シークレット禁止**: シークレット・認証情報をハードコードしない
