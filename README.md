# Serverless Practice App

元資料「AWSバッチ構成の整理と確認事項」の構成（EventBridge Scheduler / Step Functions / Lambda / SQS FIFO）を、外部サービスをスタブにして動かすデモ

## 概要

学習用に想定した AWS バッチ構成（実在のシステムではない）を手元で動かし、サービス同士のつながりと、失敗がどう伝わるかを確かめるためのデモです。外部サービス（SendGrid / MySQL / BigQuery / Cuenote FC / Slack）はすべてスタブで、実在の宛先へは何も送りません。

主な機能:

- **定時起動**: EventBridge Scheduler が毎日 9:00（日本時間）に Step Functions のステートマシンを起動する（投入 → データ連携の順）
- **メール送信**: 投入 Lambda が MySQL スタブの配信対象を SQS FIFO（+ DLQ）へ積み、Consumer Lambda が 1 件ずつメール送信スタブへ渡す
- **データ連携**: データ連携 Lambda が MySQL スタブから読んだデータを、S3（実バケット）・BigQuery スタブ・Cuenote FC スタブへ書き出す
- **失敗通知**: 実行が `FAILED` / `TIMED_OUT` / `ABORTED` で終わると、EventBridge rule が Slack 通知 Lambda を呼ぶ。Consumer 側の失敗（DLQ 行き）は通知されない（元資料のリスクの再現）
- **失敗の注入**: 実行入力の `failAt` で投入・データ連携・Consumer のいずれかを失敗させ、通知に乗る / 乗らないの違いを確かめる
- **LMI（学習目的）**: `dev` ではデータ連携 Lambda を Lambda Managed Instances で動かし、ステートマシンが非同期の呼び出しとタスクトークンで結果を待つ。実行入力の `holdSeconds` で待ち時間を足し、Lambda の 15 分の上限を越える実行を再現する。存在する間は EC2 の料金がかかるため、`dev` は検証の間だけ作って消す（[09「LMI」](docs/09-architecture-specification.md#lmilambda-managed-instances)）

技術スタックは TypeScript（Node.js 22）の Lambda、土台を Terraform・アプリを AWS CDK で管理する 2 段構成で、LocalStack（`local`）と実 AWS（`dev`）の両方へ同じ IaC でデプロイします。詳細は [09 アーキテクチャ仕様書](docs/09-architecture-specification.md#技術スタック) を参照してください。

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

`dev` では `aws login --profile <名前>` でログインし、`AWS_PROFILE=<名前>` を付けて各スクリプトを呼びます（長期のアクセスキーは使いません。[09「ステージ」](docs/09-architecture-specification.md#ステージ)）。

`dev` で初めて使う前に、state を置くバケットを作ります（Terraform では管理しません。[09「Terraform の state」](docs/09-architecture-specification.md#terraform-の-state)）。何度実行しても、ずれている設定だけを直します。

```bash
./scripts/tfstate-bucket.sh dev           # 無ければ作り、設定をそろえる（直す前に確認する）
./scripts/tfstate-bucket.sh dev --check   # 直さずに比べる（ずれがあれば終了コード 1）
```

`dev` で LMI を使う前に、消し忘れに備える予算アラート（日次 1 USD を超えたらメール）を作ります。通知先は `.env` の `BUDGET_ALERT_EMAIL`（または同じ名前の環境変数）に置きます。予算はアカウント単位で、`stack.sh dev down` では消えません（[09「予算アラート」](docs/09-architecture-specification.md#予算アラート)）。

```bash
./scripts/budget-alert.sh dev           # 無ければ作り、設定をそろえる（直す前に確認する）
./scripts/budget-alert.sh dev --check   # 直さずに比べる（ずれがあれば終了コード 1）
```

```bash
./scripts/terraform.sh local init     # state の置き場所を設定する
./scripts/terraform.sh local apply    # 土台を作る（IAM・SQS・S3・Schedule group・SSM。dev は LMI の VPC・キャパシティプロバイダも）
./scripts/terraform.sh local destroy  # 土台を消す（CDK を先に消す）
```

土台とアプリをまとめて作る・消すときは `stack.sh` を使います（Terraform → CDK の順に作り、CDK → Terraform の順に消します）。`local` では確認を省き、`dev` では Terraform・CDK の確認を残します。アプリ（CDK）だけを操作するときは `./scripts/cdk.sh <stage> {bootstrap|deploy|destroy}` を使います。

```bash
./scripts/stack.sh local up    # Terraform → CDK の順に作る
./scripts/stack.sh local down  # CDK → Terraform の順に消す
```

バッチの実行と結果の確認は `batch.sh` で行います。`failAt` で失敗を、`--hold-seconds` でデータ連携の遅延を注入できます（[02「F-6」](docs/02-requirements-specification.md#f-6-失敗の注入)）。

```bash
./scripts/batch.sh local run                   # 起動し、終わるまで待って状態・エラーを出す
./scripts/batch.sh local run dataSync          # enqueue / dataSync / consumer のいずれかで失敗を注入する
./scripts/batch.sh dev run --hold-seconds 960  # データ連携が結果を返す前に 960 秒待つ（0〜1,200。待つ上限は 360 秒 + この秒数）
./scripts/batch.sh local logs <実行名>         # 4 つの Lambda のログから、その実行の行だけを出す
./scripts/batch.sh local dlq                   # DLQ のメッセージ数を出す
```

受け入れ条件（[02](docs/02-requirements-specification.md#受け入れ条件)）と `tfstate-bucket.sh` は IT でまとめて確かめられます。LocalStack の起動とデプロイが前提で、約 6 分かかります。CI（`ci.yml` の `it`）も同じスクリプトを同じ順で実行します。

```bash
npm run test:it
```

ドキュメント・シェルスクリプト・Terraform の検査は次のコマンドで実行します。

```bash
./scripts/lint-docs.sh
./scripts/check-doc-links.sh  # Markdown の相対リンク（ファイル・見出し）の実在。先に npm ci が要る
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

## ライセンス

[MIT](LICENSE)
