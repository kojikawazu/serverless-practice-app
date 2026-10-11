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

土台（Terraform）は次のスクリプトで操作します。`local` は LocalStack（`tflocal`）、`dev` は実 AWS（`terraform`）を対象にします。

```bash
./scripts/terraform.sh local init     # state の置き場所を設定する
./scripts/terraform.sh local apply    # 土台を作る（IAM・SQS・S3・Schedule group・SSM）
./scripts/terraform.sh local destroy  # 土台を消す（CDK を先に消す）
```

土台とアプリをまとめて作る・消すときは `stack.sh` を使います（Terraform → CDK の順に作り、CDK → Terraform の順に消します）。`local` では確認を省き、`dev` では Terraform・CDK の確認を残します。アプリ（CDK）だけを操作するときは `./scripts/cdk.sh <stage> {bootstrap|deploy|destroy}` を使います。

```bash
./scripts/stack.sh local up    # Terraform → CDK の順に作る
./scripts/stack.sh local down  # CDK → Terraform の順に消す
```

バッチの実行と結果の確認は `batch.sh` で行います。`failAt` で失敗を注入できます（[02「F-6」](docs/02-requirements-specification.md#f-6-失敗の注入)）。

```bash
./scripts/batch.sh local run                   # 起動し、終わるまで待って状態・エラーを出す
./scripts/batch.sh local run dataSync          # enqueue / dataSync / consumer のいずれかで失敗を注入する
./scripts/batch.sh local logs <実行名>         # 4 つの Lambda のログから、その実行の行だけを出す
./scripts/batch.sh local dlq                   # DLQ のメッセージ数を出す
```

受け入れ条件（[02](docs/02-requirements-specification.md#受け入れ条件)）は IT でまとめて確かめられます。LocalStack の起動とデプロイが前提で、約 4 分かかります。CI（`ci.yml` の `it`）も同じスクリプトを同じ順で実行します。

```bash
npm run test:it
```

ドキュメント・シェルスクリプト・Terraform の検査は次のコマンドで実行します。

```bash
./scripts/lint-docs.sh
./scripts/lint-shell.sh
./scripts/lint-terraform.sh   # Terraform の整形・構文（CI も同じものを実行）
./scripts/check-secret-files.sh
```

## AI エージェント向けルール

開発ルールの唯一の正本は [`.claude/rules/`](.claude/rules/) です。各エージェントは次の入口ファイルから同じルールを参照します。

| エージェント | 入口ファイル |
|---|---|
| Claude Code | [CLAUDE.md](CLAUDE.md) |
| Codex | [AGENTS.md](AGENTS.md) |

ルール本文は各入口ファイルへ複製しません。ルールファイルの追加・削除・改名時は、`CLAUDE.md`・`AGENTS.md`・この節を同一変更で同期してください。
