# Serverless Practice App

元資料「AWSバッチ構成の整理と確認事項」の構成（EventBridge Scheduler / Step Functions / Lambda / SQS FIFO）を、外部サービスをスタブにして動かすデモ

## 概要

<!-- 記入: アプリケーションの目的・主な機能・技術スタックを記載する -->

元資料は [docs/references/aws-batch-architecture.md](docs/references/aws-batch-architecture.md)、目的とスコープは [要求仕様書](docs/01-business-requirements.md) を参照してください。仕様書は [docs/](docs/README.md) を参照してください。

## セットアップ

<!-- 記入: 前提ツール・依存関係のインストール・環境変数の設定手順を記載する -->

## 使い方

<!-- 記入: ローカル起動・テスト・デプロイのコマンドを記載する -->

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
