# その他仕様書

用語集・コーディング規約・参照資料をまとめる。標準仕様書（01〜09）に収まらない補足を置く。

## 目次

- [用語集](#用語集)
- [コーディング規約・命名](#コーディング規約命名)
- [参照資料・ライブラリ](#参照資料ライブラリ)
- [その他注記](#その他注記)

## 用語集

| 用語 | 説明 |
|------|------|
| ステージ | デプロイ先の区別。`local`（LocalStack）と `dev`（実 AWS）の 2 つ |
| LocalStack | AWS のサービスを手元の Docker コンテナで模倣するツール。`local` ステージの実行環境（[LocalStack 解説](guides/localstack.md)） |
| スタブ | 外部サービス（SendGrid・Slack・MySQL・BigQuery・Cuenote FC）の代わり。送信の代わりに構造化ログを出す（09「外部サービスのスタブ」） |
| 失敗の注入 | 実行入力の `failAt` で指定した箇所を意図的に失敗させること（02「F-6」） |
| 実行名 | Step Functions の実行ごとの名前（`$$.Execution.Name`）。ログ・S3 のキー・重複排除 ID で 1 回の実行を識別する |
| 配信対象 | メールの宛先。MySQL スタブが返す固定の 3 件 |
| 連携ファイル | データ連携 Lambda が S3 に書く JSON |
| 部分バッチ応答 | Consumer が失敗したメッセージだけを `batchItemFailures` で返し、その分だけを再配信させる仕組み |
| オーケストレーション | Step Functions が順番を決めて呼ぶ連携（投入 → データ連携） |
| コレオグラフィ | 各サービスがイベントに反応して動く連携（SQS → Consumer、状態変化 → 通知） |
| 土台 / アプリ | Terraform が持つ変更頻度の低いリソース / CDK が持つ頻繁に変わるリソース |

## コーディング規約・命名

コーディング規約は `.claude/rules/` を正本とする（TypeScript は `typescript.md`・`jsdoc.md`、IaC は `iac.md`）。ここにはこのデモ固有の命名だけを書く。

| 対象 | 規約 | 例 |
|---|---|---|
| AWS リソース名 | `serverless-practice-app-<stage>-<name>` | `serverless-practice-app-dev-enqueue` |
| ステートマシン | 同上、`<name>` は `batch` | `serverless-practice-app-local-batch` |
| SQS FIFO | 同上、末尾に `.fifo` | `serverless-practice-app-dev-mail.fifo` / `serverless-practice-app-dev-mail-dlq.fifo` |
| SSM パラメータ | `/serverless-practice-app/<stage>/<name>` | `/serverless-practice-app/dev/queue/url` |
| Lambda の `<name>` | handler のファイル名と一致させる（kebab-case） | `functions/src/handlers/data-sync.ts` → `data-sync` |
| エラークラス | `<内容>Error`。`name` プロパティをクラス名と一致させる（Step Functions がこの名前で判定するため） | `InjectedFailureError` |

**S3 バケット名は例外**: バケット名は全アカウントで一意のため、`serverless-practice-app-<stage>-exports-<アカウント ID>` とする。

## 参照資料・ライブラリ

| ライブラリ / 資料 | 用途 |
|-----------|------|
| [AWS バッチ構成の整理と確認事項](references/aws-batch-architecture.md) | 本デモの元資料。再現する構成・シーケンス・論点の出典 |
| `@aws-sdk/client-sqs` / `@aws-sdk/client-s3` | 投入 Lambda・データ連携 Lambda から AWS を呼ぶ |
| `zod` | 入力の検証と型の導出（`typescript.md`） |
| `aws-cdk-lib` / `constructs` | アプリ側の IaC |
| `aws-cdk` | CDK の CLI（`cdk synth` / `deploy`） |
| `aws-cdk-local` | `cdklocal`。CDK を LocalStack へ向ける |
| `tsx` | CDK アプリ（TypeScript）をそのまま実行する |
| `vitest` | テストランナー |
| `aws-sdk-client-mock` | UT で AWS SDK の呼び出しをモックする |
| `@types/aws-lambda` | Lambda のイベント・応答の型（`SQSBatchResponse` 等） |
| `esbuild` | `NodejsFunction` によるバンドル |
| `eslint` / `typescript-eslint` / `eslint-plugin-jsdoc` / `eslint-config-prettier` / `prettier` | 静的解析・整形（`typescript.md`） |

依存の追加・削除は README のセットアップ手順も更新する（`documentation.md`）。

## その他注記

- **元資料との差分**: VPC・Security Group は作らない（09「費用」）。データ連携の書き出し順と Lambda の分割（1 つにまとめる）は元資料で未確定のため、本デモで決めた（03「データ連携 Lambda」）
- **再現する論点としない論点**: 元資料のリスク 1（Consumer の失敗が通知されない）とリスク 4（途中失敗の残骸）は構成どおりに作れば自然に再現する。リスク 2 の投入側は決定的な重複排除 ID で塞いでいる（05「メールメッセージ」）。残りの改善提案は将来構成とする
