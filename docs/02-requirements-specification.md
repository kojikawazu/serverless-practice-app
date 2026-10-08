# 要件仕様書

機能要件の一覧と受け入れ条件を定義する。背景・目的は [`01-business-requirements.md`](./01-business-requirements.md)、各処理の詳細は [`03-functional-specification.md`](./03-functional-specification.md) を参照。

## 目次

- [機能要件](#機能要件)
- [データ項目](#データ項目)
- [受け入れ条件](#受け入れ条件)

## 機能要件

本デモは画面・HTTP API を持たない。利用者（開発者）は Step Functions の実行を起動し、ログ・S3・SQS の状態を見て構成の振る舞いを確かめる。

### F-1: 定時起動

EventBridge Scheduler が決まった時刻に Step Functions を起動する。

- Schedule 定義は CDK、入れ物の Schedule group は Terraform が持つ
- 起動は毎日 9:00（日本時間）。実行入力は `{}`（失敗を注入しない）
- 定時起動とは別に、AWS CLI から同じステートマシンを手動で起動できる

### F-2: バッチの段取り（Step Functions）

ステートマシンが `Enqueue（投入）→ DataSync（データ連携）` を順に実行する。

- 各 Lambda タスクには、一時的なエラーに限って `Retry` を付ける
- どちらかのタスクが失敗したら、実行全体を失敗（`FAILED`）で終える
- 実行入力で失敗を注入できる（F-6）

### F-3: メール送信（投入 → SQS FIFO → Consumer）

投入 Lambda が配信対象ごとにメッセージを SQS FIFO へ積み、Consumer Lambda が 1 件ずつ取り出してメール送信スタブへ渡す。

- 配信対象は MySQL スタブから取得する
- Consumer は Step Functions の外で、SQS イベントソースにより起動する
- 処理に 3 回失敗したメッセージは DLQ へ移る

### F-4: データ連携

データ連携 Lambda が MySQL スタブから読んだデータを、S3・BigQuery スタブ・Cuenote FC スタブへ順に書き出す。

- S3 はスタブにせず、Terraform が作ったバケットへ実際に書く

### F-5: 失敗通知

Step Functions の実行が `FAILED` / `TIMED_OUT` / `ABORTED` で終わったら、EventBridge rule が Slack 通知 Lambda を呼び、Slack スタブへ通知内容を出す。

- Consumer 側の失敗（DLQ 行き）は通知されない。元資料のリスク 1 をそのまま再現するためで、DLQ アラームは将来構成とする（09「将来構成」）

### F-6: 失敗の注入

実行入力の `failAt` で、指定した箇所を意図的に失敗させる。失敗の伝わり方の違い（通知に乗る / 乗らない）を試すための機能。

| `failAt` | 失敗する箇所 | 結果 |
|---|---|---|
| 省略 | なし | 実行は `SUCCEEDED`、全メッセージが送信される |
| `enqueue` | 投入 Lambda（キューに積む前） | 実行は `FAILED`、Slack 通知が出る |
| `dataSync` | データ連携 Lambda（S3 へ書いた後、BigQuery へ書く前） | 実行は `FAILED`、Slack 通知が出る。S3 にファイルだけ残る |
| `consumer` | Consumer Lambda（全メッセージ） | 実行は `SUCCEEDED`、メッセージは DLQ へ移る。Slack 通知は出ない |

### F-7: 2 段階のデプロイ

同じ IaC を `local`（LocalStack）と `dev`（実 AWS）の両方へ、Terraform → CDK の順でデプロイできる。削除は CDK → Terraform の順。

## データ項目

主要な入出力。スキーマの詳細は [05 データ仕様書](05-data-specification.md)、受け渡しの契約は [07 API 仕様書](07-api-specification.md) を参照。

| 項目 | 必須 | 制約 |
|------|------|------|
| 実行入力 `failAt` | 任意 | `enqueue` / `dataSync` / `consumer` のいずれか。それ以外の値は検証エラーで実行を失敗させる |
| 配信対象 | 必須 | MySQL スタブが返す固定データ。メールアドレスは `@example.com` のみ |
| メールメッセージ | 必須 | 配信対象 1 件につき 1 メッセージ |
| 連携ファイル | 必須 | 1 実行につき S3 オブジェクト 1 つ（JSON） |

## 受け入れ条件

`local` ステージで次をすべて確認できたら完成とする。Scheduler と状態変化イベントは LocalStack で動かない可能性があるため、その 2 点は `dev` で確認する（09「LocalStack で要検証の点」）。

- [ ] `failAt` なしで実行すると、実行が `SUCCEEDED` になり、配信対象の件数だけメール送信スタブのログが出て、S3 に連携ファイルが 1 つでき、BigQuery / Cuenote FC スタブのログが出る
- [ ] `failAt: "enqueue"` で実行すると、実行が `FAILED` になり、キューにメッセージが積まれず、Slack スタブのログに実行 ARN と状態 `FAILED` が出る
- [ ] `failAt: "dataSync"` で実行すると、実行が `FAILED` になり、S3 に連携ファイルが残り、BigQuery / Cuenote FC スタブのログは出ず、Slack スタブのログが出る
- [ ] `failAt: "consumer"` で実行すると、実行は `SUCCEEDED` のまま、約 3 分後に配信対象の件数のメッセージが DLQ に移り、Slack スタブのログは出ない
- [ ] `failAt` に未定義の値を渡すと、実行が `FAILED` になり、Slack スタブのログが出る
- [ ] 同じ実行の投入 Lambda が Retry で再実行されても、5 分以内ならキューのメッセージは重複しない（UT で確認する）
- [ ] `dev` で、Schedule が定時に実行を起動し、`FAILED` の実行で Slack スタブのログが出る
- [ ] CDK → Terraform の順に削除すると、両方のスタックがエラーなく消える
