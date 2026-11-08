# ドキュメント索引

このプロジェクトの仕様・設計ドキュメント一覧。プロジェクト概要はリポジトリ直下の [`../README.md`](../README.md) を参照。

## 読み進め順（おすすめ）

目的によって 2 通りある。仕様書（01〜11）は「このプロジェクトで何を決めたか」、[解説](#技術の解説guides)は「その技術は何で、どう動くか」を書いている。

### 仕様を確かめる順

`01 要求 → 02 要件 → 03 機能 → 05 データ → 06 セキュリティ → 07 API → 08 テスト → 09 アーキテクチャ`。
04・10・11 は随時参照。

### 構成を学ぶ順

AWS のサービスやツールの仕組みから学ぶときは、全体像 → 流れ → 各技術の順に読む。

1. **何を作るか**: [01 要求仕様書](01-business-requirements.md) と [元資料](references/aws-batch-architecture.md)
2. **全体像**: 09「[システム構成図](09-architecture-specification.md#システム構成図)」
3. **流れ**: 03「[処理の流れ](03-functional-specification.md#処理の流れ)」のシーケンス図（正常系・実行の失敗・起動されない失敗）
4. **各技術**: 下記「[技術の解説](#技術の解説guides)」を、処理の流れの順（EventBridge → Step Functions → Lambda → SQS FIFO → LMI）に読み、次に失敗の見張り（CloudWatch アラーム）と呼び出しの許可（IAM）、そのあと土台と環境（Terraform → CDK → LocalStack）を読む
5. **動かして分かったこと**: 09「[LocalStack での検証結果](09-architecture-specification.md#localstack-での検証結果)」・「[`dev` での検証結果](09-architecture-specification.md#dev-での検証結果)」と [教訓ログ](lessons-learned.md)

## 技術の解説（guides）

このプロジェクトで使っている技術の仕組みを説明する。値や設計の決定は 01〜11 が正本で、解説はそれを参照し、本文を複製しない。

| 解説 | 扱う内容 |
|---|---|
| [EventBridge](guides/eventbridge.md) | 定時起動の Scheduler と、失敗を通知へ流すルール |
| [Step Functions](guides/step-functions.md) | ステートマシン・`Retry`・タスクトークン |
| [Lambda](guides/lambda.md) | 実行環境・呼び出し方ごとの再試行・SQS からの起動 |
| [SQS FIFO](guides/sqs-fifo.md) | メッセージグループ・重複排除・DLQ |
| [LMI](guides/lmi.md) | Lambda Managed Instances と、15 分を超える実行 |
| [CloudWatch アラーム](guides/cloudwatch.md) | メトリクスの評価・欠損データ・壁時計の窓と、実行が始まらない失敗の検知 |
| [IAM](guides/iam.md) | ロールと信頼ポリシー・ID ベースとリソースベースのポリシー・評価の順序と、サービスどうしの呼び出しの許可 |
| [Terraform](guides/terraform.md) | 土台（IAM・SQS・S3 など）の管理と state |
| [CDK](guides/cdk.md) | アプリ（Lambda・ステートマシンなど）の管理と、Terraform からの受け渡し |
| [LocalStack](guides/localstack.md) | 手元で AWS を再現する仕組みと、実 AWS との違い |

S3・SSM Parameter Store は、使っているが解説がまだ無い（[#142](https://github.com/kojikawazu/serverless-practice-app/issues/142) で追加する）。それまでは 09「[IaC の責務分担](09-architecture-specification.md#iac-の責務分担)」と [06 セキュリティ仕様書](06-security-specification.md) が決定を書いている。

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
| [`guides/`](guides/) | （手動配置） | 使っている技術の解説（一覧は上記「[技術の解説](#技術の解説guides)」） |

## 関連

- 開発ルール: [`../CLAUDE.md`](../CLAUDE.md)、[`../AGENTS.md`](../AGENTS.md) と [`../.claude/rules/`](../.claude/rules/)
- ドキュメント更新の影響マップ: [`../.claude/rules/documentation.md`](../.claude/rules/documentation.md)
