# Step Functions 解説

AWS Step Functions とは何か、どう動くか、このプロジェクトでなぜ・どう使うかをまとめる。このプロジェクト固有の決定（ステートの並び・タイムアウト・`Retry` の値・エラー名の契約）は [03 機能仕様書](../03-functional-specification.md#ステートマシンbatch)・[04 非機能仕様書](../04-non-functional-specification.md)・[07 API 仕様書](../07-api-specification.md)・[09 アーキテクチャ仕様書](../09-architecture-specification.md#step-functions-の流れ)が正本で、本書はそれらを参照し、本文を複製しない。Lambda 側の動き（呼び出し方・非同期の再試行）は [Lambda 解説](lambda.md)を前提にする。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-10-17 に確認）、このプロジェクトで確かめたことは 09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [Step Functions とは](#step-functions-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## Step Functions とは

処理の手順（どの順に何を呼び、失敗したらどうするか）を JSON で定義し、その手順どおりに AWS のサービスを呼び出していくサービス。手順を書いた定義を**ステートマシン**、その中の 1 つ 1 つの段を**ステート**、ステートマシンを 1 回動かしたものを**実行**と呼ぶ（公式）。

| 用語 | 意味 |
|---|---|
| ステートマシン | 手順の定義。Amazon States Language（JSON）で書く |
| ステート | 手順の 1 段。`Task`（サービスを呼ぶ）・`Choice`（分岐）・`Wait`・`Parallel`・`Map`（繰り返し）・`Pass`・`Succeed`・`Fail` の 8 種類（公式） |
| 実行 | ステートマシンを 1 回動かしたもの。名前・入力・状態・実行履歴を持つ |

呼び出しの順序・待ち・再試行・タイムアウトを、関数のコードではなく定義の側に持てるのが要点。関数どうしが直接呼び合わないため、どこで失敗したかが実行履歴に残る。

## 仕組み

### Standard と Express

ステートマシンには 2 つの種類があり、**作った後に変えられない**（公式「ワークフローの種類の選び方」）。

| 観点 | Standard | Express |
|---|---|---|
| 最大の実行時間 | 1 年 | 5 分 |
| 実行の保証 | exactly-once（`Retry` を除き、各ステートは 1 回だけ動く） | 非同期の Express は at-least-once、同期の Express は at-most-once |
| 実行履歴 | Step Functions が 90 日保持する | 残らない。CloudWatch Logs に出す設定をしたときだけ |
| 課金 | 状態遷移の回数 | 実行の回数・時間・メモリ |
| `.sync` / `.waitForTaskToken` | 使える（対応するサービスに限る） | 使えない |
| EventBridge への状態変化イベント | 送られる | 送られない |
| 同じ名前の実行 | 90 日間は再利用できない | すぐ再利用できる（冪等ではない） |

短時間に大量に動かす処理は Express、長く待つ・確実に 1 回だけ動かす・履歴を残したい処理は Standard が向く。

### サービス統合のパターン

`Task` ステートからサービスを呼ぶ方法は 3 つある（公式「サービス統合のパターン」）。

| パターン | 書き方 | 動き |
|---|---|---|
| Request Response（既定） | `arn:aws:states:::lambda:invoke` | API を呼び、応答を受けたらすぐ次へ進む |
| Run a Job | 末尾に `.sync` | 呼んだジョブ（Batch・ECS など）が終わるまで待つ |
| Wait for a Callback | 末尾に `.waitForTaskToken` | タスクトークンを渡し、誰かが `SendTaskSuccess` / `SendTaskFailure` を呼ぶまで待つ |

どのパターンに対応するかはサービスごとに違い、**Lambda は `.sync` に対応しない**（公式）。Lambda の呼び出しは、既定では同期（`RequestResponse`）で、`.waitForTaskToken` を付けても同期のまま。非同期にするには、`Arguments`（JSONPath では `Parameters`）に `FunctionName` と並べて `InvocationType: "Event"` を書く（公式「Lambda の統合」）。`Payload` の中に書くと、関数への入力として渡るだけになる。

タスクトークンは、実行のコンテキスト（JSONata では `$states.context.Task.Token`、JSONPath では `$$.Task.Token`）から取り出して、呼ぶ相手に渡す。返す側の上限は、`SendTaskSuccess` の出力が 256 KiB、`SendTaskFailure` の `error` が 256 文字・`cause` が 32,768 文字（公式）。タスクが終わった後や時間切れの後にトークンで返すと `TaskTimedOut` になる。

### タイムアウトとハートビート

| 設定 | 既定（公式） | 切れたとき |
|---|---|---|
| タスクの `TimeoutSeconds` | 99,999,999 秒（実質無制限。実行の上限 1 年が先に効く） | タスクが `States.Timeout` で失敗する |
| タスクの `HeartbeatSeconds` | 99,999,999 秒。`TimeoutSeconds` より小さくする | タスクが失敗する（エラー名は下記） |
| ステートマシン全体の `TimeoutSeconds` | 無し | 実行が `TIMED_OUT` になる |

**既定ではタイムアウトが実質無いため、待つタスクには必ず置く**（公式のベストプラクティスも、タイムアウトを明示するよう勧めている）。結果を返す相手が落ちると、タイムアウトが無ければ実行は 1 年待ち続ける。

ハートビートは、待っているタスクに「まだ動いている」と知らせる仕組みで、`.waitForTaskToken` のタスクでは相手が `SendTaskHeartbeat` を送る。**非同期で呼んだ Lambda では、ハートビートは呼んだ直後から数え始める**（同期で呼んだ場合は、関数が終わってから数え始める。公式）。

ハートビートが切れたときのエラー名は、**公式の中で記述が揺れている**。Task ステートのページは `States.Timeout` と書き、エラー処理のページは `States.HeartbeatTimeout` をその用途の名前として定義している。このプロジェクトでは観測していない（#90）。

### Retry と Catch

失敗したステートの扱いは、ステートごとに `Retry`（やり直す）と `Catch`（別のステートへ逃がす）で書く（公式「エラー処理」）。

| `Retry` の項目 | 既定（公式） |
|---|---|
| `ErrorEquals` | 必須。対象のエラー名 |
| `IntervalSeconds` | 1 秒 |
| `MaxAttempts` | 3 回（0 は「やり直さない」） |
| `BackoffRate` | 2.0 |
| `MaxDelaySeconds` / `JitterStrategy` | 上限なし / `NONE` |

予約されたエラー名には落とし穴がある（公式）。

- `States.ALL` は、`States.Runtime`（定義や式の誤り。やり直しても直らない）と `States.DataLimitExceeded`（256 KiB 超え）を拾わない
- `States.TaskFailed` は、`States.Timeout` 以外の既知のエラーに一致する。タイムアウトをやり直したいなら、`States.Timeout` を別に書く
- **`Retry` のやり直しも状態遷移として課金される**

### 実行の状態と状態変化イベント

実行は `RUNNING` から、`SUCCEEDED`（成功）・`FAILED`（失敗）・`TIMED_OUT`（全体のタイムアウト）・`ABORTED`（停止された）のどれかで終わる（ほかに、やり直し待ちの `PENDING_REDRIVE`。公式）。

Standard の実行は、状態が変わるたびに EventBridge の既定のイベントバスへイベント（`source: aws.states`、`detail-type: Step Functions Execution Status Change`）を送る。このイベントは**ベストエフォートで、順不同で届くことがある**（公式）。エスケープした後の入出力が 248 KiB を超えると、入出力はイベントから外される。

### 入出力の書き方（JSONata と JSONPath）

ステート間でデータを受け渡す式の書き方は 2 つあり、ステートマシンの最上位の `QueryLanguage` で選ぶ（省略すると JSONPath。公式）。JSONata（2024 年 11 月から）では、JSONPath の 5 つの項目（`InputPath` / `Parameters` / `ResultSelector` / `ResultPath` / `OutputPath`）が `Arguments` と `Output` の 2 つにまとまる。最上位を JSONata にしたステートマシンには、JSONPath のステートを混ぜられない。

## このプロジェクトで使う理由

元資料の構成のうち、処理の段（投入 → データ連携）を順に動かし、失敗を通知に乗せる部分を Step Functions で動かす（09「[Step Functions の流れ](../09-architecture-specification.md#step-functions-の流れ)」）。

| 使っているもの | このプロジェクトでの使い方 | 正本 |
|---|---|---|
| 種類 | **Standard**。`.waitForTaskToken` と状態変化イベントが Standard でしか使えないため。CDK では種類を指定しておらず、既定に頼っている（明示は #90） | 09「[Step Functions の流れ](../09-architecture-specification.md#step-functions-の流れ)」 |
| ステート | `Enqueue` → `DataSync` の 2 つの `Task` だけ。分岐・並列・`Catch` は持たない | 03「[ステートマシン](../03-functional-specification.md#ステートマシンbatch)」 |
| 統合のパターン | `Enqueue` は Request Response（同期）。`DataSync` は `.waitForTaskToken` + `InvocationType: "Event"`（非同期で呼び、関数がタスクトークンで結果を返す） | 09「[対象の段と呼び出し方](../09-architecture-specification.md#対象の段と呼び出し方)」 |
| 入出力 | JSONata。実行入力に実行名（とタスクトークン）を足してタスクに渡し、タスクの出力は次へ流さず実行入力をそのまま渡す | 07「[タスク入力](../07-api-specification.md#タスク入力投入データ連携-lambda-共通)」 |
| タイムアウト | `DataSync` にタスクのタイムアウトとハートビート、ステートマシン全体に 40 分 | 04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」 |
| `Retry` | Lambda の一時的なエラーにだけ付ける。CDK の既定の `Retry`（`retryOnServiceExceptions`）は外して付け直している | 04「[リトライ](../04-non-functional-specification.md#リトライ)」 |
| 状態変化イベント | `FAILED` / `TIMED_OUT` / `ABORTED` を EventBridge rule で拾い、Slack 通知 Lambda に渡す | 07「[状態変化イベント](../07-api-specification.md#状態変化イベントeventbridge--slack-通知-lambda)」 |

`.waitForTaskToken` を使うのは、データ連携 Lambda を LMI で 15 分を超えて動かすため（[LMI 解説](lmi.md#このプロジェクトで使う理由)）。15 分を超えて動けるのは非同期の呼び出しだけで、非同期で呼ぶと戻り値がステートマシンに届かないため、関数がタスクトークンで結果を返す。

## 特徴と制約

### `.waitForTaskToken` と非同期の呼び出しの併用

`.waitForTaskToken` と `InvocationType: "Event"` を併用する公式の例は見つからなかった（禁止する記述も無い）。このプロジェクトでは、LocalStack でも実 AWS（`dev`）でも動いた（09「[対象の段と呼び出し方](../09-architecture-specification.md#対象の段と呼び出し方)」・「[IaC の責務](../09-architecture-specification.md#iac-の責務)」）。

併用すると、ハートビートは呼んだ直後から数え始める（上記）。データ連携 Lambda は待つ間、ハートビートの期限より短い間隔で `SendTaskHeartbeat` を送っている（03「[データ連携 Lambda](../03-functional-specification.md#データ連携-lambdadata-sync)」）。

### 同じ `States.Timeout` でも、どこで切れたかで結果が違う

| 切れたところ | 実行の結果 | エラー名の出どころ |
|---|---|---|
| タスク（`DataSync` のタイムアウト） | タスクの失敗として `FAILED` | 実行の `error` に出る |
| ステートマシン全体（40 分） | `TIMED_OUT` | 実行履歴の `ExecutionTimedOut` イベントにだけ出る。実 AWS では実行にも通知にも `error` / `cause` の値が無かった |

エラー名と結果の対応は 07「[認証・エラーハンドリング](../07-api-specification.md#認証エラーハンドリング)」が正本。全体のタイムアウトの値は、仕様書の作成時に観測しないまま書いて誤っていた（教訓ログ「[TIMED_OUT の実行の error を、観測しないまま States.Timeout と仕様に書いていた](../lessons-learned.md#2026-10-13-timed_out-の実行の-error-を観測しないまま-statestimeout-と仕様に書いていた)」）。**エラー名は、名前を知っていても置き場所（実行の結果・実行履歴・状態変化イベント）が分からないので、観測してから書く。**

### Retry と Lambda の再試行の分担

同期で呼ぶ `Enqueue` は Step Functions の `Retry` がやり直す。非同期で呼ぶ `DataSync` は、Lambda の非同期の再試行を 0 にし、やり直しを Step Functions の `Retry` に任せる（[Lambda 解説](lambda.md#失敗したときに誰がやり直すか)）。関数が `SendTaskFailure` で返したエラー名にも、同じ `Retry` が効く（07「[認証・エラーハンドリング](../07-api-specification.md#認証エラーハンドリング)」）。

`Retry` の対象は公式の推奨とは違う。公式の推奨（と CDK の既定）は `Lambda.ClientExecutionTimeoutException` を含み `Lambda.TooManyRequestsException` を含まないが、このプロジェクトはその逆（04「[リトライ](../04-non-functional-specification.md#リトライ)」）。違いの判断と理由の記録は #90。

### 実行名と冪等性

実行名は 1〜80 文字で、空白や `/` `#` `%` などの記号は使えない。CloudWatch Logs に記録するなら、英数字・`-`・`_` だけを使うよう勧められている（公式）。

Standard の `StartExecution` は、**実行中のものと同じ名前・同じ入力で呼んだときだけ**、同じ実行の応答を返す（冪等）。入力が違う、または同じ名前の実行がすでに終わっていると `ExecutionAlreadyExists` になる（公式）。このプロジェクトでは、定時の起動の実行名は UUID になり（誰が付けているかは [EventBridge 解説](eventbridge.md#定時の起動の実行名を誰が付けているか)）、手動の起動はスクリプトが日時から名前を作る。実行名は S3 のキーと SQS の重複排除 ID に入るため、文字を制限して検証する（06「[入力バリデーション](../06-security-specification.md#入力バリデーション)」）。

### 状態変化イベントだけに通知を頼っている

失敗の通知は、状態変化イベントを EventBridge rule で拾う方法だけに頼っている。公式はこのイベントをベストエフォートとしているが、欠けたときに気づく仕組みは持っておらず、この制約は仕様書（02・09）にも書かれていない（2026-10-17 時点）。

### 料金

Standard は状態遷移 1,000 回あたり $0.025（東京も同額）で、毎月 4,000 回は無料（12 か月で失効しない。公式）。`Retry` のやり直しも 1 回ずつ数えられる。

## LocalStack との違い

| 違い | 正本 |
|---|---|
| 状態変化イベントは EventBridge rule まで届く（`SUCCEEDED` は rule の条件で除外される） | 09「[LocalStack での検証結果](../09-architecture-specification.md#localstack-での検証結果)」 |
| 状態変化イベントの日時の項目が、実 AWS と違う形（文字列）で届く | 07「[状態変化イベント](../07-api-specification.md#状態変化イベントeventbridge--slack-通知-lambda)」 |
| `TIMED_OUT` の実行の `error` が `null` で、`States.Timeout` の名前は出ない | 07「[認証・エラーハンドリング](../07-api-specification.md#認証エラーハンドリング)」 |
| EventBridge Scheduler が定時に起動しない（作成などの API は動く）ため、`local` では手動で起動する | 09「[LocalStack での検証結果](../09-architecture-specification.md#localstack-での検証結果)」 |

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| 関数が落ちたのに、実行が終わらない | 待つタスクにタイムアウトを置いていない（既定は実質無制限）。タスクのタイムアウトとハートビートを置く |
| `InvocationType: "Event"` を付けたのに同期で呼ばれる | `Payload` の中に書いている。`Arguments`（`Parameters`）の直下に書く |
| 非同期で呼んだ関数の処理中に、ハートビートのタイムアウトで失敗する | 非同期の呼び出しでは呼んだ直後から数え始める。関数の処理中もハートビートを送る |
| `States.ALL` の `Catch` があるのに実行が落ちる | `States.Runtime`（定義・式の誤り）と `States.DataLimitExceeded` は `States.ALL` で拾えない |
| `States.TaskFailed` の `Retry` で、タイムアウトがやり直されない | `States.TaskFailed` は `States.Timeout` に一致しない。別に書く |
| `TIMED_OUT` の通知に `error` が無い | 実行全体のタイムアウトの名前は実行履歴にだけ出る（上記） |
| 同じ名前で `StartExecution` すると `ExecutionAlreadyExists` | 入力が違うか、同じ名前の実行がすでに終わっている。Standard では 90 日間使えない |
| `.waitForTaskToken` がエラーになる | Express では使えない。種類は作った後に変えられないため、作り直す |
| 定義を更新した直後の実行が、古い定義で動く | 定義の更新の反映は結果整合（公式）。更新の直後は少し待つ |

## 参考資料

- [Learn about state machines in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-statemachines.html)・[State machine structure](https://docs.aws.amazon.com/step-functions/latest/dg/statemachine-structure.html)
- [Choosing workflow type in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)（Standard と Express）
- [Discover service integration patterns in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html)（3 つのパターン・タスクトークン）
- [Invoke an AWS Lambda function with Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/connect-lambda.html)（`InvocationType`・ハートビートの数え始め）
- [Task workflow state](https://docs.aws.amazon.com/step-functions/latest/dg/state-task.html)（`TimeoutSeconds`・`HeartbeatSeconds` の既定）
- [Handling errors in Step Functions workflows](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)（`Retry`・`Catch`・予約されたエラー名）
- [Best practices for Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html)（タイムアウトの明示・Lambda の `Retry` の推奨）
- [Automating Step Functions event delivery with EventBridge](https://docs.aws.amazon.com/step-functions/latest/dg/eventbridge-integration.html)（状態変化イベント・ベストエフォート）
- [StartExecution](https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html)（実行名・冪等性）・[SendTaskSuccess](https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskSuccess.html)・[SendTaskFailure](https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskFailure.html)
- [Transforming data with JSONata in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html)
- [Step Functions service quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html)（256 KiB・実行履歴の 25,000 イベント）
- [AWS Step Functions pricing](https://aws.amazon.com/step-functions/pricing/)
