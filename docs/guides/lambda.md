# Lambda 解説

AWS Lambda とは何か、どう動くか、このプロジェクトでなぜ・どう使うかをまとめる。本書の対象は通常の Lambda 関数で、LMI（Lambda Managed Instances）は別の解説で扱う。このプロジェクト固有の決定（各関数の処理・タイムアウト・リトライの値）は [03 機能仕様書](../03-functional-specification.md)・[04 非機能仕様書](../04-non-functional-specification.md)・[09 アーキテクチャ仕様書](../09-architecture-specification.md) が正本で、本書はそれらを参照し、本文を複製しない。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-10-17 に確認）、このプロジェクトで確かめたことは 09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [Lambda とは](#lambda-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [SQS をイベントソースにしたとき](#sqs-をイベントソースにしたとき)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## Lambda とは

コード（関数）だけを置くと、呼ばれたときに AWS が実行環境を用意して動かすサービス。サーバーの起動・停止・台数の調整を自分で持たず、呼ばれた回数と動いた時間だけ課金される（公式。料金はリクエスト数と、メモリ × 実行時間の GB 秒で決まり、無料枠は毎月 100 万リクエスト・40 万 GB 秒）。

公式ドキュメントは、本書が扱う通常の関数を **Event Function** と呼び、LMI などの別の動かし方と分けて説明している。同時実行・タイムアウト・初期化の上限は、この区別で値が変わる。本書では単に「関数」と書く。

## 仕組み

### 実行環境のライフサイクル

関数は、Lambda が用意する隔離された実行環境の中で動く。実行環境は次の 3 つの段階をたどる（公式「実行環境のライフサイクル」）。

```text
Init（初期化）            Invoke（呼び出し）       Shutdown（終了）
ランタイム・拡張・         ハンドラーを実行する      しばらく呼ばれないと、
ハンドラーの外のコード     （呼ばれるたびに繰り返す） 環境ごと捨てられる
を 1 回だけ実行する
```

- **Init は 10 秒まで**（公式）。超えると、最初の呼び出しのときに関数のタイムアウトを上限としてやり直される
- **コールドスタートとウォームスタート**: 新しい環境を作って Init から始めるのがコールドスタート。呼び出しが終わった環境は同じ関数の次の呼び出しに再利用され、Init を飛ばせる（ウォームスタート）。Init の時間も課金される（公式）
- **環境は永続しない**: 呼ばれ続けていても、数時間ごとに作り直される（公式）。ハンドラーの外の変数や `/tmp` は、次の呼び出しに残っているかもしれない「キャッシュ」として扱い、残っていることを前提にしない

### 同時実行

1 つの実行環境は、一度に 1 つの呼び出しだけを処理する。同時に呼ばれた分だけ環境が増え、その数を同時実行数と呼ぶ（公式「同時実行」）。

| 項目 | 値（公式） |
|---|---|
| アカウント・リージョンごとの同時実行数 | 既定 1,000（新しいアカウントは低い場合があり、使うにつれて自動で上がる） |
| 関数に予約（reserved concurrency）できる合計 | 900 まで。100 は予約していない関数のために常に残される |
| 増え方の上限 | 関数ごとに 10 秒あたり 1,000 環境 |

上限を越えた呼び出しはスロットル（`TooManyRequestsException`）になる。予約同時実行は、その関数の分を確保すると同時に上限にもなる（設定は無料）。

### 呼び出し方

| 呼び出し方 | 動き | 呼んだ側に返るもの |
|---|---|---|
| 同期（`RequestResponse`。既定） | 関数が終わるまで待つ | 関数の戻り値・エラー |
| 非同期（`Event`） | Lambda が内部のキューにイベントを入れ、すぐに受け付けを返す。関数はその後で動く | 受け付けたこと（202）だけ。戻り値・エラーは届かない |
| イベントソースマッピング | Lambda がキュー・ストリーム（SQS など）を読みに行き、まとめて**同期**で関数を呼ぶ | 呼んだのは Lambda 自身。結果はキューの削除・再配信に使われる |

どの呼び出し方かで、失敗したときに誰がやり直すかが変わる（下記「特徴と制約」）。

### 版と修飾子

| 名前 | 意味 |
|---|---|
| `$LATEST` | 編集できる、未発行の版。デプロイで中身が上書きされる |
| 発行した版（`1`、`2` …） | `publish-version` で作る、変更できない版 |
| エイリアス（例: `prod`） | 発行した版を指す名前。指す先を付け替えられる |

ARN の末尾に付ける `:1`・`:prod`・`:$LATEST` を**修飾子**（API の `Qualifier`）と呼ぶ。修飾子を付けない ARN（unqualified ARN）で呼ぶと、`$LATEST` が呼ばれる（公式「バージョン」）。このプロジェクトは版を発行せず、修飾子なしで呼んでいる（データ連携 Lambda の LMI は例外で、LMI の解説で扱う）。

## このプロジェクトで使う理由

元資料の構成（EventBridge Scheduler → Step Functions → Lambda → SQS FIFO）の処理の段を、Lambda で動かす。4 つの関数が、それぞれ別の呼ばれ方をしている。

| 関数 | 呼ぶもの | 呼ばれ方 | 仕様 |
|---|---|---|---|
| 投入（`enqueue`） | Step Functions | 同期 | 03「[投入 Lambda](../03-functional-specification.md#投入-lambdaenqueue)」 |
| データ連携（`data-sync`） | Step Functions | 非同期 + タスクトークン（関数が自分で結果を返す） | 03「[データ連携 Lambda](../03-functional-specification.md#データ連携-lambdadata-sync)」・09「[対象の段と呼び出し方](../09-architecture-specification.md#対象の段と呼び出し方)」 |
| Consumer（`consumer`） | SQS FIFO | イベントソースマッピング | 03「[Consumer Lambda](../03-functional-specification.md#consumer-lambdaconsumer)」 |
| Slack 通知（`notify-slack`） | EventBridge rule（実行の失敗・Scheduler の DLQ のアラーム） | 非同期 | 03「[Slack 通知 Lambda](../03-functional-specification.md#slack-通知-lambdanotify-slack)」 |

ランタイム・アーキテクチャ・メモリなどの共通の設定は、09「[技術スタック](../09-architecture-specification.md#技術スタック)」と 04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」を参照。関数は CDK で作り、実行ロールは Terraform で作る（09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」）。

## 特徴と制約

### 失敗したときに誰がやり直すか

呼び出し方ごとに、やり直す主体が違う。

| 呼び出し方 | やり直す主体 | 既定の動き（公式） |
|---|---|---|
| 同期 | 呼んだ側 | Lambda はやり直さない。呼んだ側がエラーを受け取って決める |
| 非同期 | Lambda | 関数がエラーを返すと、さらに 2 回試す（1 回目の後に約 1 分、2 回目の後に約 2 分あける）。スロットルやシステムのエラーは、最大 6 時間まで間隔を広げながら試す |
| SQS のイベントソースマッピング | キュー | 失敗したメッセージが可視性タイムアウトの後に再び見え、もう一度配られる |

このプロジェクトの判断は、この違いから来ている（値は 04「[リトライ](../04-non-functional-specification.md#リトライ)」）。

- **投入 Lambda**: 同期なので、Step Functions の `Retry` がやり直す
- **データ連携 Lambda**: 非同期で呼ぶので、既定のままだと Lambda が 2 回やり直し、同じタスクトークンで処理が二重に走る。**非同期の再試行を 0 にし**、やり直しは Step Functions の `Retry` に任せる。そのため関数は失敗しても例外を投げず、`SendTaskFailure` で結果を返す
- **Slack 通知 Lambda**: 非同期で、通知の失敗は Lambda の 2 回の再試行に任せる。一方、対象外のイベントは投げずに正常に終える。投げても同じイベントを受け直すだけで、結果は変わらないため
- **Consumer Lambda**: 失敗したメッセージだけを返し、キューに再配信させる（下記「SQS をイベントソースにしたとき」）

### 非同期の呼び出しの設定

非同期の再試行回数（`MaximumRetryAttempts`、0〜2）・イベントを待たせる最大時間（`MaximumEventAgeInSeconds`、60〜21,600 秒、既定 6 時間）・失敗したイベントの送り先（destination）は、`EventInvokeConfig` で関数・版・エイリアスごとに設定できる（公式）。破棄したイベントを残す DLQ は、これとは別に関数の設定で付ける。

**どの設定が効くかは、呼び出し側が指定した修飾子で決まり、実際に動いた版では決まらない。** LMI で修飾子なしの呼び出しが `$LATEST.PUBLISHED` で動いても、効いたのは `$LATEST` の設定だった（このプロジェクトで確かめた。09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」の「LMI」・教訓ログ 2026-10-17「LMI の非同期の再試行設定を『付いている版』から推論し、効いていないと誤認した」）。設定を確かめるときは、「どの版に付いているか」ではなく「呼ぶ側がどの修飾子で呼ぶか」から辿る。

### 同じイベントが 2 回届くことがある

非同期の呼び出しもイベントソースマッピングも、配信は**少なくとも 1 回**で、エラーが無くても同じイベントが重複して届くことがある（公式）。公式は関数を冪等に作ることを強く勧めている。

- 投入 Lambda: 重複排除 ID を `<実行名>:<配信対象 ID>` で決定的に作り、同じ実行が再投入されても FIFO が重複を除く（03「[投入 Lambda](../03-functional-specification.md#投入-lambdaenqueue)」）
- データ連携 Lambda: 非同期の再試行は 0 にしているが、それとは別の重複の配信を防ぐ仕組みは持っていない（コードで確認。重複したときの動きは確かめていない）

### 15 分の上限

関数のタイムアウトは既定 3 秒、上限 900 秒（15 分）（公式）。15 分を超える処理は、そのままでは関数で動かせない。このデモでは、データ連携 Lambda を LMI で非同期に呼び、15 分を超えて動かした。処理時間ごとの実行先は 09「[処理時間ごとの実行先](../09-architecture-specification.md#処理時間ごとの実行先)」を参照。

### ペイロードの上限

呼び出しの入力は、同期で 6 MB、非同期で 1 MB まで（公式）。このデモの入力は小さい（配信対象 3 件・タスク入力）ため当たらないが、大きなデータは S3 に置いてキーだけを渡す。データ連携 Lambda が連携ファイルを S3 に書いて、キーを返しているのと同じ形。

### ロググループ

関数のログは、既定で CloudWatch Logs のロググループ `/aws/lambda/<関数名>` に出る（公式）。ロググループが無ければ最初の呼び出しのときに作られ、CloudWatch Logs の既定で保持期間は無期限になる。この自動で作られたロググループは IaC の管理外で、関数を消しても残る。

このプロジェクトは、関数と同じ名前のロググループを CDK で先に作り、保持期間 7 日・スタックの削除で一緒に消す（04「[保持期間](../04-non-functional-specification.md#保持期間)」）。LMI のキャパシティプロバイダのロググループでも同じ問題が起き、Terraform で先に作るようにした（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」の「LMI」。#71）。

## SQS をイベントソースにしたとき

SQS の詳しい動き（FIFO・メッセージグループ・DLQ）は [SQS FIFO 解説](sqs-fifo.md)に任せ、ここでは Lambda 側から見た要点だけを書く。

- **Lambda がキューを読みに行く**: イベントソースマッピングがキューをポーリングし、複数のメッセージを 1 つのバッチにして、関数を同期で呼ぶ（公式）
- **既定では、バッチ全体が成否の単位**: 関数がエラーを返すと、成功したものを含めてバッチの全メッセージが再び見えるようになる（公式）
- **部分バッチ応答**: `ReportBatchItemFailures` を有効にし、失敗したメッセージの ID を `batchItemFailures` で返すと、それだけが再配信される。ただし関数が例外を投げれば、バッチ全体の失敗になる（公式）。Consumer Lambda はこの形で返す（07「[Consumer Lambda の出力](../07-api-specification.md#consumer-lambda-の出力部分バッチ応答)」）
- **FIFO では、最初の失敗の後ろも失敗として返す**: 公式は、FIFO で部分バッチ応答を使うなら、最初の失敗で処理をやめ、残りもすべて `batchItemFailures` に入れるよう求めている。同じグループの後続を先に処理すると、再配信された前のメッセージが後から届き、順序が逆転するため。Consumer Lambda は、失敗したメッセージと同じグループの後続だけを失敗として返し、別のグループはそのまま処理する（03「[Consumer Lambda](../03-functional-specification.md#consumer-lambdaconsumer)」）
- **可視性タイムアウトは関数のタイムアウトの 6 倍以上**（公式の推奨）。短いと、処理中のメッセージが再び見えて二重に処理される。このプロジェクトは、Consumer のタイムアウトを正本にして 6 倍を計算し、ずれない構造にしている（04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」の「連動するパラメータ」）

## LocalStack との違い

LocalStack でも関数は動く。呼び出すと、LocalStack が関数用の別のコンテナを起動して、その中で動かす（[LocalStack 解説](localstack.md)の「仕組み」）。このプロジェクトで出た違いは次のとおり。

| 違い | 影響と扱い |
|---|---|
| EventBridge から届く Step Functions の状態変化イベントで、日時の項目が本物と違う形（文字列）で届く | 通知 Lambda が日時の項目を数値として検証していて、失敗通知を捨てていた。通知に使わない項目は検証しないように直した（教訓ログ 2026-10-09「失敗通知 Lambda が、通知に使わない日時項目の形の違いで失敗通知を捨てていた」・07「[状態変化イベント](../07-api-specification.md#状態変化イベントeventbridge--slack-通知-lambda)」） |
| LMI を使えない（今のライセンスでは API を呼べない） | `local` のデータ連携 Lambda は通常の関数で動き、タイムアウトは 900 秒まで（04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」） |

**LocalStack で動いたことは、実 AWS で動くことの証明にはならない。** 非同期の再試行の効き方（上記）のように、実 AWS でしか確かめられないものは `dev` で確かめる。

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| 非同期で呼んだ関数の処理が、1 分後・3 分後にもう一度走る | 関数がエラーを返し、Lambda の非同期の再試行（既定 2 回）が働いた。二重に走らせたくないなら、再試行を 0 にするか、関数を冪等にする |
| 非同期の再試行を 0 にしたのに再試行された（または、その逆） | 呼ぶ側が指定した修飾子と、設定を付けた修飾子が違う。設定は呼び出し側の修飾子で決まる（上記「非同期の呼び出しの設定」） |
| 関数を消したのにロググループが残り、保持期間が無期限 | Lambda が最初の呼び出しのときに自動で作ったもの。IaC で先に同じ名前のロググループを作る（上記「ロググループ」） |
| SQS の 1 件の失敗で、成功したメッセージまで再処理される | 部分バッチ応答を使っていない、または関数が例外を投げている。失敗した ID を `batchItemFailures` で返す |
| FIFO で、同じグループのメッセージの順序が入れ替わる | 部分バッチ応答で、失敗したメッセージの後ろの同じグループを成功として処理した。最初の失敗以降を失敗として返す |
| ESM でバンドルした関数が `Dynamic require of "node:https" is not supported` で落ちる | AWS SDK をバンドルに含めると、SDK の中の `require` が ESM の出力で動かない。出力の先頭で `createRequire` により `require` を用意する（09「[実装で設計から変えた点](../09-architecture-specification.md#実装で設計から変えた点)」） |
| 呼び出しが `TooManyRequestsException` になる | 同時実行数の上限（アカウント全体・予約同時実行）に達した。Step Functions からの呼び出しでは、このエラーを `Retry` の対象にしている（04「[リトライ](../04-non-functional-specification.md#リトライ)」） |

## 参考資料

- [Understanding the Lambda execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)（実行環境・Init の 10 秒・コールドスタート）
- [Understanding Lambda Event Function scaling](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html)（同時実行・予約同時実行・増え方の上限）
- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)（同時実行・タイムアウト・ペイロードの上限）
- [Invoking a Lambda function asynchronously](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html)
- [How Lambda handles errors and retries with asynchronous invocation](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html)（非同期の再試行・重複の配信）
- [PutFunctionEventInvokeConfig](https://docs.aws.amazon.com/lambda/latest/api/API_PutFunctionEventInvokeConfig.html)（非同期の呼び出しの設定の範囲）
- [Invoke](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html)（呼び出し方・ペイロードの上限）
- [Manage Lambda function versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html)・[Create an alias for a Lambda function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-aliases.html)
- [Configure Lambda function timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)
- [Sending Lambda function logs to CloudWatch Logs](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs.html)・[Working with log groups and log streams](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html)（既定の保持期間）
- [Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)・[Handling errors for an SQS event source](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)・[Configuring an SQS event source](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
