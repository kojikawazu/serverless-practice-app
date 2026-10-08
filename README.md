# Serverless Practice App

元資料「AWSバッチ構成の整理と確認事項」の構成（EventBridge Scheduler / Step Functions / Lambda / SQS FIFO）を、外部サービスをスタブにして動かすデモ

## 概要

<!-- 記入: アプリケーションの目的・主な機能・技術スタックを記載する -->

元資料は [docs/references/aws-batch-architecture.md](docs/references/aws-batch-architecture.md)、目的とスコープは [要求仕様書](docs/01-business-requirements.md) を参照してください。仕様書は [docs/](docs/README.md) を参照してください。

## セットアップ

Node.js 22 以上が必要です（バージョンは [`.nvmrc`](.nvmrc)）。LocalStack・Terraform などインフラ側の前提ツールは [09 アーキテクチャ仕様書](docs/09-architecture-specification.md#前提ツール) を参照してください。

```bash
npm ci
```

`local` ステージ（LocalStack）を使う場合は、LocalStack のアカウント（無料の Hobby プラン）を作り、認証トークンを `.env` に置いてから起動します。詳しくは [09「LocalStack の認証」](docs/09-architecture-specification.md#localstack-の認証) を参照してください。

```bash
cp .env.example .env          # LOCALSTACK_AUTH_TOKEN を書き入れる（.env は Git 管理外）
./scripts/localstack.sh up    # 起動し、使うサービスがそろうまで待つ
./scripts/localstack.sh down  # 停止する（LocalStack 内のリソースも消える）
```

TypeScript は 6.0 系に固定しています（`typescript-eslint` の対応範囲が `<6.1.0` のため）。更新するときは `typescript-eslint` の peer 依存を確かめてください。

## 使い方

コードの検査とテストは次のコマンドで実行します。CI（`.github/workflows/ci.yml`）も同じ npm スクリプトを呼びます。

```bash
npm run typecheck     # 型検査（tsc --noEmit）
npm run lint          # ESLint（警告も失敗扱い）
npm run format:check  # Prettier の整形チェック（npm run format で整形）
npm test              # Vitest + カバレッジ（functions/src の行カバレッジ 80% 未満で失敗）
```

デプロイ・実行のコマンドは、インフラの実装時に追記します。

ドキュメントとシェルスクリプトの検査は次のコマンドで実行します。

```bash
./scripts/lint-docs.sh
./scripts/lint-shell.sh
./scripts/check-secret-files.sh
```

## AI エージェント向けルール

開発ルールの唯一の正本は [`.claude/rules/`](.claude/rules/) です。各エージェントは次の入口ファイルから同じルールを参照します。

| エージェント | 入口ファイル |
|---|---|
| Claude Code | [CLAUDE.md](CLAUDE.md) |
| Codex | [AGENTS.md](AGENTS.md) |

ルール本文は各入口ファイルへ複製しません。ルールファイルの追加・削除・改名時は、`CLAUDE.md`・`AGENTS.md`・この節を同一変更で同期してください。
