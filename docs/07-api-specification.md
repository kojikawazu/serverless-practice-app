# API 仕様書

サービス間の受け渡し（イベント・メッセージ・Lambda の入出力）の形式とエラーの契約を定義する。データの意味は [`05-data-specification.md`](./05-data-specification.md)、検証ルールは [`06-security-specification.md`](./06-security-specification.md) を参照。

本デモは HTTP API を持たないため、テンプレートの「エンドポイント」を「呼び出しの経路」に読み替える。

## 目次

- [前提](#前提)
- [エンドポイント一覧](#エンドポイント一覧)
- [リクエスト/レスポンス形式](#リクエストレスポンス形式)
- [認証・エラーハンドリング](#認証エラーハンドリング)

## 前提

- 呼び出しはすべて AWS サービス間で行う。形式は JSON
- 各 handler は入力を Zod で検証する。本書の JSON 例は形の説明であり、正本は `functions/src/schemas/` のスキーマ（05「スキーマ定義」）
- 関数名は `serverless-practice-app-<stage>-<name>`、ステートマシン名は `serverless-practice-app-<stage>-batch`

## エンドポイント一覧

| 呼び出し元 | 呼び出し先 | 方式 | 入力 |
|---------|------|------|------|
| Scheduler / 開発者 | ステートマシン `batch` | `StartExecution` | 実行入力 |
| ステートマシン | 投入 Lambda `enqueue` | 同期呼び出し（`lambda:invoke` 統合） | タスク入力 |
| 投入 Lambda | メール送信キュー | `SendMessageBatch` | MailMessage |
| メール送信キュー | Consumer Lambda `consumer` | イベントソースマッピング | SQS イベント |
| ステートマシン | データ連携 Lambda `data-sync` | 同期呼び出し（`lambda:invoke` 統合） | タスク入力 |
| EventBridge rule | Slack 通知 Lambda `notify-slack` | 非同期呼び出し | 状態変化イベント |

## リクエスト/レスポンス形式

### 実行入力（`StartExecution` の `input`）

```json
{ "failAt": "dataSync" }
```

- `failAt` は省略できる。Scheduler からの定時起動では `{}` を渡す
- 値と結果の対応は 02「F-6」

### タスク入力（投入・データ連携 Lambda 共通）

ステートマシンが実行名と実行入力から組み立てる。

```json
{ "executionName": "manual-20261008-001", "failAt": "dataSync" }
```

ASL では `Payload` を次のように組む。`failAt` が実行入力に無いと `States.Runtime` で落ちるため、ステートマシンの先頭で既定値を補う（実装時に方式を決める）。

```json
{ "executionName.$": "$$.Execution.Name", "failAt.$": "$.failAt" }
```

### 投入 Lambda の出力

```json
{ "enqueued": 3 }
```

### データ連携 Lambda の出力

```json
{ "exported": 3, "s3Key": "exports/2026-10-08/manual-20261008-001.json" }
```

ステートマシンはタスクの出力を次のステートの入力に流さない（`ResultPath` で実行入力を保つ）。`DataSync` が実行入力の `failAt` を読めるようにするため。

### SQS メッセージ本文

```json
{
  "executionName": "manual-20261008-001",
  "recipientId": "r-001",
  "email": "user1@example.com",
  "subject": "serverless-practice-app デモ配信",
  "simulateFailure": false
}
```

属性（`MessageGroupId` / `MessageDeduplicationId`）は 05「メールメッセージ」を参照。

### Consumer Lambda の出力（部分バッチ応答）

```json
{ "batchItemFailures": [{ "itemIdentifier": "<失敗したメッセージの messageId>" }] }
```

イベントソースマッピングで `ReportBatchItemFailures` を有効にする。全件成功なら空配列を返す。

### 状態変化イベント（EventBridge → Slack 通知 Lambda）

rule のイベントパターン:

```json
{
  "source": ["aws.states"],
  "detail-type": ["Step Functions Execution Status Change"],
  "detail": {
    "status": ["FAILED", "TIMED_OUT", "ABORTED"],
    "stateMachineArn": ["<batch の ARN>"]
  }
}
```

Slack 通知 Lambda が使う `detail` のフィールドは `executionArn` / `stateMachineArn` / `name` / `status` / `startDate` / `stopDate` / `error` / `cause`。`error` と `cause` は `TIMED_OUT` / `ABORTED` では `null` になりうる。

### スタブへの出力（構造化ログ）

スタブは送信の代わりに 1 行の JSON をログへ出す。どのスタブも `stub` フィールドを持つ。

```json
{ "level": "INFO", "stub": "slack", "function": "notify-slack", "executionName": "manual-20261008-001", "status": "FAILED", "error": "InjectedFailureError", "cause": "..." }
```

| `stub` | 出力する内容 |
|---|---|
| `sendgrid` | 宛先・件名・`recipientId` |
| `slack` | 実行名・状態・エラー名・原因・実行 ARN |
| `bigquery` | 書き込み件数・`executionName` |
| `cuenote-fc` | 登録件数・`executionName` |

## 認証・エラーハンドリング

認証は IAM のみ（06「認証」）。HTTP ステータスコードの代わりに、Lambda が投げるエラーの名前（`errorType`）で契約する。Step Functions の `Retry` と実行結果の `error` はこの名前で判定される。

| エラー名 | 発生条件 | Step Functions の `Retry` | 実行結果 |
|---|---|---|---|
| `ValidationError` | 入力がスキーマに合わない | しない | `FAILED` |
| `InjectedFailureError` | `failAt` で失敗を注入した | しない | `FAILED` |
| `EnqueuePartialFailureError` | `SendMessageBatch` の一部が失敗した | する。全件を送り直すが、重複排除 ID が決定的なため送信済みの分は重複しない | 尽きたら `FAILED` |
| `Lambda.ServiceException` ほか一時的なエラー | Lambda サービス側の一時的な失敗 | する（04「リトライ」） | 尽きたら `FAILED` |
| `States.Timeout` | ステートマシンが 5 分を超えた | — | `TIMED_OUT` |

Consumer Lambda はエラーを投げず、失敗したメッセージを `batchItemFailures` で返す。Slack 通知 Lambda は対象外のイベントでもエラーを投げない（04「エラーハンドリング・堅牢性」）。
