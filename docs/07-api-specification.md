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
| ステートマシン | データ連携 Lambda `data-sync` | 非同期呼び出し（`lambda:invoke.waitForTaskToken` 統合、`InvocationType: "Event"`） | タスク入力 + タスクトークン |
| データ連携 Lambda | ステートマシン | `SendTaskSuccess` / `SendTaskFailure` / `SendTaskHeartbeat` | データ連携 Lambda の出力・エラー |
| Scheduler | Scheduler の DLQ（SQS 標準キュー） | Scheduler が送る（`DeadLetterConfig`） | 起動に失敗した呼び出し（下記「Scheduler の DLQ のメッセージ」） |
| EventBridge rule | Slack 通知 Lambda `notify-slack` | 非同期呼び出し | 状態変化イベント / アラームの状態変化イベント |

## リクエスト/レスポンス形式

### 実行入力（`StartExecution` の `input`）

```json
{ "failAt": "dataSync", "holdSeconds": 960 }
```

- `failAt` / `holdSeconds` は省略できる。Scheduler からの定時起動では `{}` を渡す
- 値と結果の対応は 02「F-6」。`holdSeconds` は検証用の待ち時間（秒、0〜1,200 の整数）で、データ連携 Lambda だけが使う

### タスク入力（投入・データ連携 Lambda 共通）

ステートマシンが実行名と実行入力から組み立てる。

```json
{ "executionName": "manual-20261008-001", "failAt": "dataSync" }
```

データ連携 Lambda には、結果を返す宛先のタスクトークン `taskToken` も足す。投入 Lambda のタスク入力は `taskToken` を受け付けない（未知のキーとして拒否する）。

```json
{ "executionName": "manual-20261008-001", "holdSeconds": 960, "taskToken": "<タスクトークン>" }
```

ステートマシンは JSONata で書き、`Payload` を「実行入力に実行名を足したもの」として組む。

```text
{% $merge([$states.input, {"executionName": $states.context.Execution.Name}]) %}
```

データ連携 Lambda の `Payload` はタスクトークンも足す。

```text
{% $merge([$states.input, {"executionName": $states.context.Execution.Name, "taskToken": $states.context.Task.Token}]) %}
```

- 実行入力に `failAt` が無ければ、タスク入力にも無いまま渡る。JSONPath の `"failAt.$": "$.failAt"` のように、項目が無いだけで `States.Runtime` で落ちることがない
- 実行入力に未知のキー（`failat` などの綴り違い）があれば、そのままタスク入力に入り、タスク入力のスキーマ（未知のキーを拒否）で `ValidationError` になる

### 投入 Lambda の出力

```json
{ "enqueued": 3 }
```

### データ連携 Lambda の出力

```json
{ "exported": 3, "s3Key": "exports/2026-10-08/manual-20261008-001.json" }
```

戻り値ではなく、`SendTaskSuccess` の `output` として返す（非同期で呼ばれるため、戻り値はステートマシンに届かない）。

ステートマシンはタスクの出力を次のステートの入力に流さない（各タスクの `Output` を `{% $states.input %}` にして実行入力を保つ）。`DataSync` が実行入力の `failAt` を読めるようにするため。

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

Slack 通知 Lambda が使う `detail` のフィールドは `executionArn` / `name` / `status` / `error` / `cause`。`error` と `cause` は `TIMED_OUT` / `ABORTED` では `null` になりうる（`TIMED_OUT` は実 AWS・LocalStack とも値が無かった。09「`dev` での検証結果」）。

それ以外のフィールドは検証しない。`startDate` / `stopDate` は AWS ではエポックミリ秒、LocalStack では ISO 8601 文字列で届き、通知に使わない項目の形の違いで失敗通知を捨てないため（#30）。対象のステートマシンの絞り込みは rule のイベントパターン（`stateMachineArn`）が担う。

### アラームの状態変化イベント（EventBridge → Slack 通知 Lambda）

次の 2 つのアラームが `ALARM` になったときに届く。rule はアラームごとに 1 つで、イベントパターンは `alarmName` だけが違う。

| アラーム名 | 意味 | rule 名 |
|---|---|---|
| `serverless-practice-app-<stage>-scheduler-dlq` | Scheduler がステートマシンを起動できず、DLQ へ送った（04「リトライ」の「起動の失敗の通知」。#101） | `serverless-practice-app-<stage>-scheduler-dlq-alarm` |
| `serverless-practice-app-<stage>-scheduler-missed-run` | Scheduler がその日（日本時間）の起動を 1 回も試みなかった（04「リトライ」の「実行が始まらない日の通知」。#109） | `serverless-practice-app-<stage>-scheduler-missed-run-alarm` |

```json
{
  "source": ["aws.cloudwatch"],
  "detail-type": ["CloudWatch Alarm State Change"],
  "detail": {
    "alarmName": ["serverless-practice-app-<stage>-scheduler-dlq"],
    "state": { "value": ["ALARM"] }
  }
}
```

Slack 通知 Lambda が使う `detail` のフィールドは `alarmName` / `state.value`（`ALARM` だけを受理する）/ `state.reason`。それ以外のフィールド（`previousState`・`configuration` など）は検証しない。

実 AWS の `dev` で届いた `ALARM` への変化（2026-10-21。#101。EventBridge の別の rule から CloudWatch Logs へ書き出して観測。アカウント ID・`reasonData` の中身は省略）:

```json
{
  "version": "0",
  "id": "d0e0a508-8f80-75cf-cd7f-0348a8142bf7",
  "detail-type": "CloudWatch Alarm State Change",
  "source": "aws.cloudwatch",
  "account": "<アカウント ID>",
  "time": "2026-10-21T12:37:58Z",
  "region": "ap-northeast-1",
  "resources": ["arn:aws:cloudwatch:ap-northeast-1:<アカウント ID>:alarm:serverless-practice-app-dev-scheduler-dlq"],
  "detail": {
    "alarmName": "serverless-practice-app-dev-scheduler-dlq",
    "state": {
      "value": "ALARM",
      "reason": "Threshold Crossed: 1 datapoint [1.0 (21/10/26 12:30:00)] was greater than or equal to the threshold (1.0).",
      "reasonData": "<JSON 文字列>",
      "timestamp": "2026-10-21T12:37:58.559+0000"
    },
    "previousState": { "value": "OK", "reason": "Threshold Crossed: no datapoints were received for 1 period and 1 missing datapoint was treated as [NonBreaching].", "reasonData": "<JSON 文字列>", "timestamp": "2026-10-21T12:26:58.557+0000" },
    "configuration": {
      "metrics": [{ "id": "<ID>", "metricStat": { "metric": { "namespace": "AWS/SQS", "name": "NumberOfMessagesSent", "dimensions": { "QueueName": "serverless-practice-app-dev-scheduler-dlq" } }, "period": 300, "stat": "Sum" }, "returnData": true }],
      "description": "Scheduler がステートマシンを起動できず、呼び出しを DLQ へ送った（docs/04「リトライ」）"
    }
  }
}
```

- 通知に使う 3 つのフィールドは、公式「Alarm events and EventBridge」の例から作ったスキーマのとおりの位置・型で届いた。スキーマは変えていない。テストの偽物は、この実物に合わせた（`functions/test/schemas/alarm-state-change-event.test.ts`）
- `state.reason` の文は、公式の例（`1 out of the last 1 datapoints ... (minimum 1 datapoint for OK -> ALARM transition).`）と違い、`1 datapoint [...] was greater than or equal to the threshold (1.0).` だった。通知は文をそのまま出すだけで、文面を解釈しない
- LocalStack はアラームの状態変化を EventBridge に出さない（09「LocalStack での検証結果」）。この形は実 AWS でだけ観測した
- 実行が始まらない日のアラーム（#109）のイベントは未観測。上の実物は DLQ のアラームのもので、通知に使う 3 つのフィールドは、アラームの種類によらず同じ位置にあると公式の例から推測している。`dev` で観測する

### Scheduler の DLQ のメッセージ

Scheduler が、起動に失敗した呼び出しを送る。このデモのコードは読まず、人が `receive-message` で原因を確かめるために使う。本文は呼び出しの内容で、原因はメッセージの属性に入る。

実 AWS の `dev` で、権限の無いステートマシン（存在しない ARN）へ起動させたときに届いたメッセージ（2026-10-21。#101。`receive-message --message-attribute-names All` で観測）。`RetryPolicy` の `MaximumRetryAttempts` を 0 回と 2 回にして 1 回ずつ起動させ、`EXHAUSTED_RETRY_CONDITION` だけが違った。権限を一時的に足して IAM を通した場合（`StateMachineDoesNotExist`）は、表の下に書く:

| 属性・本文 | 観測した値 | 公式「Configuring a schedule's dead-letter queue」の記述 |
|---|---|---|
| 本文 | `{"Input":"{}","Name":"<実行名の UUID>","StateMachineArn":"<ターゲットの ARN>"}`。`StartExecution` に渡すはずだった引数 | 「呼び出しの詳細と、ターゲットから受け取った応答を含む JSON」 |
| `ERROR_CODE` | `AccessDeniedException` | ターゲットの API が返したエラー。Scheduler 側の失敗なら `AWS.Scheduler.InternalServerError` |
| `ERROR_MESSAGE` | `User: arn:aws:sts::<アカウント ID>:assumed-role/serverless-practice-app-dev-scheduler/<セッション> is not authorized to perform: states:StartExecution on resource: <ターゲットの ARN> because no identity-based policy allows the states:StartExecution action` | 同上 |
| `EXHAUSTED_RETRY_CONDITION` | 0 回: `MaximumRetryAttempts`。2 回: **項目が無い** | やり直せるエラーのときだけ付く。`MaximumRetryAttempts` か `MaximumEventAgeInSeconds` |
| `RETRY_ATTEMPTS` | 0 回・2 回とも `0` | 例にだけ載り、説明は無い（名前からはやり直した回数と読める） |
| `SCHEDULED_TIME` | `2026-10-21T12:34:00Z`。Schedule の式の時刻と一致した（送信は 12:34:46Z） | 例にだけ載り、説明は無い |
| `TARGET_ARN` | ステートマシンの ARN そのもの | 説明は `arn:aws:scheduler:::aws-sdk:<service>:<apiAction>` の形（ユニバーサルターゲットの例）。このデモはテンプレート化されたターゲット（ステートマシンの ARN を直接指す）のため、形が違う |
| `SCHEDULE_ARN` / `EXECUTION_ID` | Schedule の ARN / 本文の `Name` と同じ UUID | 例にだけ載り、説明は無い |
| `IS_PAYLOAD_TRUNCATED` | `false` | 例にだけ載り、説明は無い |
| `CONTAINS_INVALID_PAYLOAD` | `false` | 例にも説明にも無い（観測で初めて分かった。意味は未確認） |

- **存在しないステートマシンへの起動は、存在の確認より先に IAM で拒否された。** Scheduler の実行ロールは `states:StartExecution` をこのデモのステートマシンの ARN だけに許している（06「認可」）
- **IAM を通すと `StateMachineDoesNotExist` になった。** その ARN への `states:StartExecution` を実行ロールに一時的に足し、`MaximumRetryAttempts` 2 回で起動させると、`ERROR_CODE` が `StateMachineDoesNotExist`、`ERROR_MESSAGE` が `State Machine Does Not Exist: '<ターゲットの ARN>'`、`RETRY_ATTEMPTS` が `0`、`EXHAUSTED_RETRY_CONDITION` が無いメッセージが、予定の約 46 秒後に届いた。やり直されなかった
- **`AccessDeniedException` はやり直されなかった。** やり直しを 2 回まで許しても `RETRY_ATTEMPTS` は `0` で、予定の時刻の約 46 秒後に DLQ へ送られた（0 回のときと同じ）。CloudTrail の `StartExecution`（`errorCode: AccessDenied`）も 1 回の起動につき 1 件だった（09「`dev` での検証結果」）
- **`EXHAUSTED_RETRY_CONDITION` の有無で、やり直せるエラーかを見分けられるのは、`MaximumRetryAttempts` が 1 以上のときだけ。** 0 回では、やり直さないエラー（`AccessDeniedException`）にも `MaximumRetryAttempts` が付いた。0 回の観測だけから「付いた → やり直せるエラー」と読むと誤る（1 回目の観測ではそう推論し、2 回目で外れた）

### スタブへの出力（構造化ログ）

スタブは送信の代わりに 1 行の JSON をログへ出す。どのスタブも `stub` フィールドを持つ。

```json
{ "level": "INFO", "stub": "slack", "function": "notify-slack", "executionName": "manual-20261008-001", "status": "FAILED", "error": "InjectedFailureError", "cause": "..." }
{ "level": "INFO", "stub": "slack", "function": "notify-slack", "message": "アラームを通知しました（スタブ）", "alarmName": "serverless-practice-app-dev-scheduler-dlq", "reason": "Threshold Crossed: ..." }
```

| `stub` | 出力する内容 |
|---|---|
| `sendgrid` | 宛先・件名・`recipientId` |
| `slack` | 実行の失敗: 実行名・状態・エラー名・原因・実行 ARN。アラーム（#101）: アラーム名・`ALARM` になった理由（`message` で見分ける） |
| `bigquery` | 書き込み件数・`executionName` |
| `cuenote-fc` | 登録件数・`executionName` |

## 認証・エラーハンドリング

認証は IAM のみ（06「認証」）。HTTP ステータスコードの代わりに、Lambda が投げるエラーの名前（`errorType`）で契約する。Step Functions の `Retry` と実行結果の `error` はこの名前で判定される。

データ連携 Lambda はエラーを投げず、`SendTaskFailure` で返す。`error` にエラー名、`cause` に Lambda が投げたときと同じ形の JSON（`{"errorType": ..., "errorMessage": ...}`。`errorMessage` は 4,096 文字まで）を入れるため、`Retry` の判定・実行結果・通知の見え方は投げたときと変わらない。

| エラー名 | 発生条件 | Step Functions の `Retry` | 実行結果 |
|---|---|---|---|
| `ValidationError` | 入力がスキーマに合わない | しない | `FAILED` |
| `InjectedFailureError` | `failAt` で失敗を注入した | しない | `FAILED` |
| `EnqueuePartialFailureError` | `SendMessageBatch` の一部が失敗した | する。全件を送り直すが、重複排除 ID が決定的なため送信済みの分は重複しない | 尽きたら `FAILED` |
| `Lambda.ServiceException` ほか一時的なエラー | Lambda サービス側の一時的な失敗 | する（04「リトライ」） | 尽きたら `FAILED` |
| `States.Timeout`（`DataSync`） | `DataSync` タスクがタイムアウトを超えた（04「パフォーマンス要件」）。データ連携 Lambda が結果もハートビートも 300 秒返さなかった（結果を返せずに終えた・落ちた）ときも、この名前になる。`States.HeartbeatTimeout` ではない（LocalStack で観測。実 AWS は未観測。09「LocalStack での検証結果」） | しない | `FAILED` |
| `States.Timeout`（実行全体） | ステートマシンが 40 分を超えた | — | `TIMED_OUT`。この名前は実行履歴の `ExecutionTimedOut` イベントにだけ出る。実 AWS では実行（`describe-execution`）に `error` / `cause` の項目が無く、通知にも値が届かない（09「`dev` での検証結果」）。LocalStack では実行の `error` が `null` で、この名前は出ない（09「LocalStack での検証結果」） |

Consumer Lambda はエラーを投げず、失敗したメッセージを `batchItemFailures` で返す。Slack 通知 Lambda は対象外のイベントでもエラーを投げない（04「エラーハンドリング・堅牢性」）。
