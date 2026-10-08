# ドキュメント索引

このプロジェクトの仕様・設計ドキュメント一覧。プロジェクト概要はリポジトリ直下の [`../README.md`](../README.md) を参照。

## 読み進め順（おすすめ）

`01 要求 → 02 要件 → 03 機能 → 05 データ → 06 セキュリティ → 07 API → 08 テスト → 09 アーキテクチャ`。
04・10・11 は随時参照。

## 標準仕様書

| # | ドキュメント | 概要 |
|---|---|---|
| 01 | [要求仕様書](01-business-requirements.md) | プロジェクト背景・目標・ステークホルダー・スコープ・制約 |
| 02 | [要件仕様書](02-requirements-specification.md) | 機能要件一覧・受け入れ条件・優先度 |
| 03 | [機能仕様書](03-functional-specification.md) | 機能詳細・ユーザーフロー・UI/UX 仕様・ビジネスロジック |
| 04 | [非機能仕様書](04-non-functional-specification.md) | パフォーマンス・スケーラビリティ・可用性・信頼性要件 |
| 05 | [データ仕様書](05-data-specification.md) | データモデル・ER 図・DB スキーマ・データフロー |
| 06 | [セキュリティ仕様書](06-security-specification.md) | 認証・認可・暗号化・脆弱性対策 |
| 07 | [API 仕様書](07-api-specification.md) | エンドポイント・リクエスト/レスポンス形式・認証・エラーハンドリング |
| 08 | [テスト仕様書](08-test-specification.md) | テスト戦略・テストケース・カバレッジ目標・テストツール |
| 09 | [アーキテクチャ仕様書](09-architecture-specification.md) | システム構成・技術スタック・インフラ・デプロイ |
| 10 | [その他仕様書](10-miscellaneous-specification.md) | 用語集・参照資料・付録・その他注記 |
| 11 | [タスク](11-tasks.md) | 開発タスク・マイルストーン・スケジュール・進捗管理 |

## 継続記録

埋めて完成させるのではなく、随時追記し続けるドキュメント。

| ドキュメント | 内容 | 運用ルール |
|---|---|---|
| [教訓ログ](lessons-learned.md) | 誤り・失敗・ハマりから得た教訓 | [`../.claude/rules/lessons-learned.md`](../.claude/rules/lessons-learned.md) |

## サブフォルダ

スキル実行で生成される成果物フォルダ。生成された時点で追記する。

| フォルダ | 生成スキル | 内容 |
|---|---|---|
| `design/` | `/design-policy` | 開発設計方針（README + トピック別 01〜14） |
| `mockups/` | `/mock-screen` | 画面仕様の正本（`screens.md` / `sequences/*.md`）と、そこからレンダリングした静的 HTML モック |
| `test-design/` | `/test-design` | テスト設計ドキュメント |
| `code-reading/` | `/code-reading` | コード読解ナレッジ |
| [`references/`](references/) | （手動配置） | 元資料・外部から持ち込んだ参照資料（[AWS バッチ構成の整理と確認事項](references/aws-batch-architecture.md)） |
| [`guides/`](guides/) | （手動配置） | 使っている技術の解説。仕様の決定は 01〜11 が正本で、解説からは参照する（[LocalStack 解説](guides/localstack.md)） |

## 関連

- 開発ルール: [`../CLAUDE.md`](../CLAUDE.md)、[`../AGENTS.md`](../AGENTS.md) と [`../.claude/rules/`](../.claude/rules/)
- ドキュメント更新の影響マップ: [`../.claude/rules/documentation.md`](../.claude/rules/documentation.md)
