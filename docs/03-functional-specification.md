# 機能仕様書

各処理（ステートマシン・Lambda 4 種）の振る舞いと処理の流れを定義する。機能要件の一覧は [`02-requirements-specification.md`](./02-requirements-specification.md) を参照。

本デモは画面を持たないため、テンプレートの「画面仕様 / 画面遷移 / UI/UX 方針」を「処理仕様 / 処理の流れ / 操作方針」に読み替える。

## 目次

- [処理仕様](#処理仕様)
- [処理の流れ](#処理の流れ)
- [操作方針](#操作方針)

## 処理仕様

入出力の形式は [07 API 仕様書](07-api-specification.md)、タイムアウト・リトライの値は [04 非機能仕様書](04-non-functional-specification.md) を参照。

### ステートマシン（`batch`）

| ステート | 種類 | 内容 |
|---|---|---|
| `Enqueue` | Lambda タスク | 投入 Lambda を呼ぶ。実行入力に実行名を足して渡す（07「タスク入力」） |
| `DataSync` | Lambda タスク（`.waitForTaskToken`） | データ連携 Lambda を非同期で呼び、関数がタスクトークンで結果を返すまで待つ。`Enqueue` と同じタスク入力にタスクトークンを足して渡す（07「タスク入力」） |

- 2 つのタスクを順に実行し、両方成功したら `SUCCEEDED` で終える。分岐・並列は持たない
- 各タスクの `Retry` は一時的なエラー（04「リトライ」）だけを対象にする。注入した失敗・検証エラーはリトライしない
- `Catch` は付けない。タスクの失敗はそのまま実行の失敗になり、状態変化イベントとして EventBridge へ出る
- `DataSync` はタイムアウトとハートビートのタイムアウトを持つ（04「パフォーマンス要件」）。関数が結果を返さずに止まっても待ち続けず、`States.Timeout` で失敗にする。ハートビートが切れたときも同じ `States.Timeout` になる（LocalStack で観測。実 AWS は未観測。09「LocalStack での検証結果」）

### 投入 Lambda（`enqueue`）

1. 入力を検証する。`failAt` が未定義の値なら検証エラーで失敗する
2. `failAt` が `enqueue` なら、キューへ積む前に注入エラーで失敗する
3. MySQL スタブから配信対象を取得する
4. 配信対象ごとにメールメッセージを作り、SQS FIFO へ送る（`SendMessageBatch`、10 件ずつ）
   - `failAt` が `consumer` なら各メッセージの `simulateFailure` を `beforeSend` に、`consumerAfterSend` なら `afterSend` にする。それ以外は `none`
5. 送った件数を返す

`SendMessageBatch` の一部が失敗した場合も、残りのバッチは送り切ってから、失敗した配信対象 ID をまとめて `EnqueuePartialFailureError` で投げる。再実行で全件を送り直しても、重複排除 ID が決定的なため 5 分以内なら重複しない（05「メールメッセージ」）。

失敗したときは、エラー名・メッセージ・スタックトレースを含むエラーログを 1 行出してから投げ直す。タスク入力の検証を通った後の失敗には `executionName` を付ける。

### Consumer Lambda（`consumer`）

SQS イベントソースから最大 5 件ずつ受け取り、1 件ずつ処理する。

1. メッセージ本文を検証する。不正な本文はその 1 件を失敗として扱う
2. `simulateFailure` が `beforeSend` なら、その 1 件を注入エラーで失敗させる（送信記録は書かない）
3. 送信記録（05「送信記録」）へ、キー `<実行名>:<配信対象 ID>` が無いことを条件に「送信中」を書く。書けなかったら、記録を読み直して分ける
   - 「送信済み」なら、送らずに成功として扱う（再配信による二重送信の防止。#136）
   - 「送信中」なら、前の受信で送ったかどうか判定できない。送り直すと二重送信になりうるため、送らずに `SendStateUnknownError` で失敗させる。メッセージは最大受信回数で DLQ へ移り、DLQ のアラームで人に知らせる（04「リトライ」の「メールの送信の失敗の通知」）
4. メール送信スタブへ渡す。失敗したら「送信中」の記録を消してから失敗させ、次の受信で送り直せるようにする
5. 記録を「送信済み」にする
6. `simulateFailure` が `afterSend` なら、ここで注入エラーで失敗させる（送った直後に落ちたことの再現）
7. 失敗したメッセージの ID だけを `batchItemFailures` で返す（部分バッチ応答）

- **失敗したメッセージと同じグループの後続メッセージは、送らずに失敗として返す。** 送ってしまうと、再配信された前のメッセージが後から届き、グループ内の順序が逆転するため。AWS の指示（FIFO の部分バッチ応答では、最初の失敗で処理をやめ、残りをすべて失敗として返す）をグループ単位に緩めた扱いで、Powertools for AWS Lambda の `skipGroupOnError` と同じ形（[公式](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)）。別のグループのメッセージは影響を受けず、そのまま送る。グループは配信対象ごとなので、影響は同じ宛先の中に閉じる
- 失敗した 1 件ごとに、`messageId`・グループ ID・エラー名・スタックトレースを含むエラーログを出す
- イベント自体の形式が不正（`Records` が無い等）なら `ValidationError` を投げ、バッチ全体を再配信させる
- 成功したメッセージは SQS から削除され、失敗したものだけが可視性タイムアウト後に再配信される
- 3 回受信しても失敗したメッセージは DLQ へ移る（`maxReceiveCount: 3`）
- Slack 通知 Lambda は呼ばない。DLQ へ移ったことは、DLQ のアラームで通知される（02「F-5」・#135）
- **送信記録で防げるのは、同じ実行の同じ宛先のメールの重複だけ。** キーに実行名を含むため、手動の再実行など、実行名の違う実行どうしの重複は防がない（05「送信記録」）
- **「送った」と「記録した」の間で落ちると、送り直さずに DLQ へ倒す。** 送った後に「送信済み」にできなかったとき・「送信中」の記録を消せなかったときは「送信中」が残り、次の受信は判定不能として失敗する。二重送信より、送ったかもしれないメールを人に確かめてもらう側を選んだ（`error-handling.md`「判定不能を正常値に丸めない」。04 の `Lambda.ClientExecutionTimeoutException` をやり直さない理由と同じ）

### データ連携 Lambda（`data-sync`）

ステートマシンから非同期で呼ばれるため、戻り値・例外はステートマシンに届かない。結果は入力のタスクトークンで返す（09「LMI（Lambda Managed Instances）」）。

1. 入力からタスクトークンを取り出す。読めなければ結果を返せないため、エラーログを出して終える
2. 入力の残りを検証する
3. MySQL スタブから配信対象を取得する
4. S3 へ連携ファイル（JSON）を書く
5. `failAt` が `dataSync` なら、ここで注入エラーで失敗する
6. BigQuery スタブへ書く
7. Cuenote FC スタブへ書く
8. `holdSeconds` があれば、その秒数だけ待つ。60 秒ごとにハートビート（`SendTaskHeartbeat`）を送る
9. 書いた件数と S3 のキーを `SendTaskSuccess` で返す

書き出しの順序は元資料で未確定のため、本デモでは上記の順に固定する。途中で失敗すると前段の書き込みが残る（元資料のリスク 4）。補償処理（巻き戻し）は持たない。

S3 のキーの日付と `exportedAt` は、同じ時刻（UTC）から作る。

2〜9 で失敗したときは、投入 Lambda と同じくエラーログを 1 行出してから、`SendTaskFailure` で失敗を返す（エラー名と `cause` の形は 07「エラーハンドリング」）。**例外は投げない。** 非同期の呼び出しで投げると、受け取るのは Lambda の再試行だけで、同じタスクトークンで処理が二重に走るため（非同期の呼び出しの再試行も 0 にしている）。ハートビート・`SendTaskSuccess` の失敗も同じく `SendTaskFailure` で返し、`SendTaskFailure` 自体が失敗したらエラーログを出して終える。そのときはステートマシン側のタイムアウトで `FAILED` になる。

環境変数の誤りだけは、ロガーを組み立てられないため例外を投げる。デプロイの誤りで、結果はハートビートのタイムアウトで `FAILED` になる。

### Slack 通知 Lambda（`notify-slack`）

受け付けるイベントは 2 種類で、`source` で見分ける（07「状態変化イベント」「アラームの状態変化イベント」）。

| イベント | 意味 | 通知に使う項目 |
|---|---|---|
| Step Functions の状態変化（`aws.states`） | 実行が `FAILED` / `TIMED_OUT` / `ABORTED` で終わった（F-5） | 実行名・実行 ARN・状態・エラー名・原因 |
| CloudWatch アラームの状態変化（`aws.cloudwatch`） | 次のどれかのアラームが `ALARM` になった。どれも実行の状態変化イベントでは知らせられない失敗。Scheduler の DLQ のアラーム（起動に失敗した。F-5・#101）、実行が始まらない日のアラーム（その日に起動を試みなかった。F-5・#109）、メール送信キューの DLQ のアラーム（実行は `SUCCEEDED` だが、メールの送信に失敗し続けたメッセージが DLQ にある。F-5・#135） | アラーム名・`ALARM` になった理由 |

1. EventBridge のイベントを検証する。対象外（形式違い・通知対象外の状態。アラームの `OK` への変化も含む）なら、理由を警告ログに出して正常に終える。エラーにすると非同期呼び出しの再試行で同じイベントを受け直すだけで、結果は変わらないため
2. 通知に使う項目を取り出す（07「スタブへの出力」）。状態変化イベントのエラー名と原因は、`null` でも項目が無くても `null` に揃える
3. Slack スタブへ通知内容を渡す。実行の失敗とアラームは、別の行（`message` が違う）で出す

通知自体が失敗した場合は、実行名（アラームならアラーム名）付きのエラーログを出してから投げ直し、Lambda の既定の再試行（2 回）に任せる。

アラームの通知には、起動に失敗した理由（エラーコード）は入らない。理由は DLQ のメッセージの属性にあり、DLQ を受信して確かめる（04「リトライ」）。実行が始まらない日のアラームでは、`get-schedule` で Schedule の状態（`DISABLED`・削除・式の変更）を、`list-executions` でその日の定時の起動の実行が本当に無いかを確かめる（メトリクスの欠けによる誤通知がありうる。04「リトライ」）。メール送信キューの DLQ のアラームでは、DLQ のメッセージの本文で、失敗した実行名と配信対象を確かめる（下記「操作方針」）。

## 処理の流れ

図は [`images/sequences/`](images/sequences/) の `.drawio.svg` が正本（編集の仕方は [09「システム構成図」](09-architecture-specification.md#システム構成図)）。丸数字はメッセージの順。タイムアウト・リトライの秒数や回数は図に書かず、[04 非機能仕様書](04-non-functional-specification.md) を正本とする。

### 正常系

![正常系のシーケンス図。Scheduler が Step Functions を起動し、投入 Lambda が MySQL スタブから配信対象を取って SQS FIFO へ積む。Consumer Lambda は Step Functions の外でキューから受け取り、SendGrid スタブへ送る。並行して Step Functions はデータ連携 Lambda を非同期で呼び、関数は S3・BigQuery・Cuenote FC へ書いてから、ハートビートと SendTaskSuccess をタスクトークンで返す。実行は SUCCEEDED で、通知はしない](images/sequences/normal.drawio.svg)

#### 15 分を超える処理（`dev` のみ・LMI）

`holdSeconds` を付けた実行。データ連携 Lambda は LMI で動き、Lambda の 15 分の上限を超えて待つ（09「[LMI（Lambda Managed Instances）](09-architecture-specification.md#lmilambda-managed-instances)」）。図の観測値は `dev` で確かめたもの（09「[`dev` での検証結果](09-architecture-specification.md#dev-での検証結果)」の「LMI」。#66）。`local` は LMI を使わないため、15 分を超えては待てない。

![15 分を超える処理のシーケンス図。開発者が holdSeconds 960 で実行を始め、投入とメールの送信は正常系と同じ。Step Functions はデータ連携 Lambda を修飾子なしで非同期に呼び、LMI の公開版で動く。関数は MySQL スタブから取得して S3・BigQuery・Cuenote FC へ書き、holdSeconds の間ハートビートを送り続ける。待つ間に 3 台中 2 台のインスタンスが終了しても途切れず、SendTaskSuccess を返して SUCCEEDED になる。dev で実行 16 分 2.6 秒・関数 961.9 秒だった](images/sequences/long-run-lmi.drawio.svg)

#### 一時的なエラーを `Retry` で吸収する

Lambda の呼び出しが一時的なエラーで失敗しても、`Retry` でやり直して成功すれば、実行は正常系と同じく `SUCCEEDED` になる（04「[リトライ](04-non-functional-specification.md#リトライ)」）。図は投入タスクで描いたが、`DataSync` タスクにも同じ `Retry` が付く。対象のエラーは CDK の定義で固定し、UT（08 #55）で確かめている。一時的なエラーは注入できないため、実行時の動きは観測していない。

![一時的なエラーを Retry で吸収するシーケンス図。Step Functions が投入 Lambda を呼び、Lambda.TooManyRequestsException などの一時的なエラーが返る。Retry の対象なので待ってから呼び直し、2 回目は MySQL スタブから取得して SQS FIFO へ積み、件数を返す。前の呼び出しで積めていた分は重複排除 ID により 5 分以内なら重複しない。以降は正常系と同じく SUCCEEDED。Retry を使い切ると FAILED になり、Slack へ通知される。実行時の動きは未観測](images/sequences/retry-transient.drawio.svg)

### 準正常系

想定内の不正な入力・一部の失敗を、決めたとおりに扱う流れ。`failAt` で注入する失敗は、下の「[実行の失敗](#実行の失敗)」で扱う。

#### 実行入力の検証エラー

実行入力がタスク入力のスキーマに合わないと、投入 Lambda が `ValidationError` で失敗する。`Retry` の対象外のため、やり直さずに `FAILED` になり、Slack へ通知される（04「[リトライ](04-non-functional-specification.md#リトライ)」）。スキーマは未知のキーも拒否するため、`failat` のような綴り違いも通さない（07「[タスク入力](07-api-specification.md#タスク入力投入データ連携-lambda-共通)」）。実行と通知のエラー名は LocalStack の IT（08 #26）で確かめた。実 AWS では未観測。

![実行入力の検証エラーのシーケンス図。開発者が failAt に未定義の値を付けて実行を始め、Step Functions が投入 Lambda をタスク入力で呼ぶ。タスク入力のスキーマに合わないため ValidationError が返る。Retry の対象外のため実行は FAILED になり、DataSync は動かない。状態変化イベントが rule を経て Slack 通知 Lambda に届き、エラー名 ValidationError を Slack スタブへ通知する。LocalStack の IT で確かめ、実 AWS では未観測](images/sequences/validation-error.drawio.svg)

#### 投入の一部の失敗を `Retry` で送り直す

`SendMessageBatch` の一部が失敗すると、投入 Lambda は残りを送り切ってから `EnqueuePartialFailureError` を投げる。投入タスクだけがこのエラーを `Retry` し、やり直しでは全件を送り直す。送れていた分は重複排除 ID が同じため、5 分以内なら重複しない（上の「[投入 Lambda](#投入-lambdaenqueue)」・05「[メールメッセージ](05-data-specification.md#メールメッセージmailmessage)」）。SQS の一部の失敗は注入できないため、実行時の動きは観測していない。

![投入の一部の失敗を Retry で送り直すシーケンス図。投入 Lambda が MySQL スタブから取得して SendMessageBatch で送り、応答の一部の項目が Failed になる。残りのバッチも送り切ってから EnqueuePartialFailureError を投げる。投入タスクだけ Retry の対象なので、Step Functions は待ってから呼び直し、投入 Lambda は全件を送り直す。前に送れた分は重複排除 ID が同じため 5 分以内なら重複しない。件数を返して以降は正常系と同じく SUCCEEDED。Retry を使い切ると FAILED になり Slack へ通知される。実行時の動きは未観測](images/sequences/enqueue-partial-failure.drawio.svg)

#### 本文が不正なメッセージ（Consumer）

Consumer Lambda は、本文が不正なメッセージの 1 件だけを失敗にし、他は送る（部分バッチ応答）。不正な本文は何度受け取っても失敗するため、最大受信回数に達すると DLQ へ移る（上の「[Consumer Lambda](#consumer-lambdaconsumer)」）。投入 Lambda は本文を型どおりに組み立てるため、`failAt` では起こせない。1 件ずつの扱いは UT（08 #11・#24）で確かめた。不正な本文を実際のキューに置いた動きは観測していない。

![本文が不正なメッセージのシーケンス図。SQS FIFO がイベントソースで最大 5 件を Consumer Lambda に渡し、うち 1 件の本文が不正。Consumer Lambda は 1 件ずつ検証し、不正な 1 件を失敗にしてエラーログを出し、残りを SendGrid スタブへ送る。同じグループの後続は送らずに失敗として返す。batchItemFailures で失敗した ID を返し、成功した分はキューから消える。失敗した分は可視性タイムアウトの後に再配信され、不正な本文は毎回失敗し、最大受信回数に達すると DLQ へ移り、DLQ のアラームで Slack へ通知される。不正な本文を実際のキューに置いた動きは未観測](images/sequences/consumer-invalid-body.drawio.svg)

#### 送った直後に落ちたメッセージの再配信（`failAt: consumerAfterSend`）

Consumer がメールを送った後、メッセージがキューから消える前に落ちると、同じメッセージが再配信される。Consumer は送信記録で「送信済み」を見つけ、送らずに成功として扱う。メールは 1 通だけになる（上の「[Consumer Lambda](#consumer-lambdaconsumer)」・05「[送信記録](05-data-specification.md#送信記録sendrecord)」・#136）。`failAt: consumerAfterSend` は、送って送信済みを記録した後に失敗させて、この流れを再現する。LocalStack の IT（08 #80）で確かめた。実 AWS では未観測。

![送った直後に落ちたメッセージの再配信のシーケンス図。Consumer Lambda は DynamoDB の送信記録に、キーが無ければ送信中を書き、SendGrid スタブへ送り、送信済みにした後、注入エラーで失敗して batchItemFailures を返す。可視性タイムアウトの後に再配信されると、送信中の書き込みはキーがあるため断られ、強い整合性で読み直すと送信済みなので、送らずに成功として扱い、メッセージは消える。送信中のままなら判定できないため送らずに失敗させ、DLQ へ移す。LocalStack の IT でメールが配信対象ごとに 1 通であることを確かめ、実 AWS では未観測](images/sequences/consumer-after-send.drawio.svg)

### 実行の失敗

実行が `FAILED` / `TIMED_OUT` / `ABORTED` で終わると、状態変化イベントが EventBridge rule を経て Slack 通知 Lambda に届く（02「F-5」）。メールの送信の失敗だけは Step Functions の外で起き、実行は `SUCCEEDED` のため状態変化イベントでは通知されない。DLQ へ移った後に、DLQ のアラームで遅れて通知される（#135）。

#### 投入の失敗（`failAt: enqueue`）

![投入の失敗のシーケンス図。投入 Lambda がキューへ積む前に InjectedFailureError で失敗し、Retry の対象外のため実行は FAILED になる。DataSync は動かない。状態変化イベントが rule を経て Slack 通知 Lambda に届き、Slack スタブへ通知する](images/sequences/fail-enqueue.drawio.svg)

#### データ連携の失敗（`failAt: dataSync`）

![データ連携の失敗のシーケンス図。投入は正常系と同じ。データ連携 Lambda は配信対象を取って S3 へ書いた後に注入エラーで失敗し、SendTaskFailure で InjectedFailureError を返す。S3 のファイルは残り、BigQuery・Cuenote FC へは書かない。Retry の対象外のため実行は FAILED になり、Slack へ通知される](images/sequences/fail-data-sync.drawio.svg)

#### データ連携の結果が返らない（ハートビート切れ）

![データ連携の結果が返らないときのシーケンス図。データ連携 Lambda が SendTask* の失敗などで結果を返せずに止まり、Step Functions はハートビートのタイムアウトで打ち切って States.Timeout で FAILED にする（LocalStack で観測。実 AWS は未観測）。Slack へ通知される。実行全体のタイムアウトを越えたときは TIMED_OUT になり、エラー名・原因の無い通知が同じ経路で届く](images/sequences/fail-heartbeat-timeout.drawio.svg)

#### メールの送信の失敗（`failAt: consumer`）

![メールの送信の失敗のシーケンス図。投入 Lambda が simulateFailure を付けて積み、実行は SUCCEEDED で終わる。Consumer Lambda は注入エラーで失敗し、同じグループの後続も失敗として batchItemFailures で返す。可視性タイムアウトの後の再配信を最大受信回数まで繰り返し、メッセージは DLQ へ移る。DLQ のメッセージ数が 1 以上で CloudWatch アラームが ALARM になり、rule を経て Slack 通知 Lambda がアラーム名と理由を通知する。実行の成功から通知までずれがある](images/sequences/fail-consumer.drawio.svg)

### 起動されない失敗

実行が始まらないため、状態変化イベントは出ない。CloudWatch アラームの `ALARM` への変化を EventBridge rule が拾い、同じ Slack 通知 Lambda を呼ぶ（04「リトライ」）。

#### Scheduler の起動の失敗（#101）

![Scheduler の起動の失敗のシーケンス図。Scheduler の StartExecution が権限の誤りなどで失敗し、Scheduler は呼び出しを属性付きで Scheduler の DLQ へ送る。DLQ の送信数が 1 以上で CloudWatch アラームが ALARM になり、rule を経て Slack 通知 Lambda がアラーム名と理由を通知する。失敗の理由は DLQ のメッセージの属性で確かめる](images/sequences/scheduler-dlq.drawio.svg)

#### 起動を試みなかった日（#109）

![起動を試みなかった日のシーケンス図。Schedule が無効化・削除・式の変更をされると、その日は起動を試みず、起動の試行回数のデータが出ない。CloudWatch アラームは日本時間の 0 時過ぎに前日を評価し、データが無いため ALARM になり、rule を経て Slack 通知 Lambda が通知する。評価のふるまいは実 AWS では未観測（#116）](images/sequences/missed-run.drawio.svg)

## 操作方針

利用者は開発者 1 人で、操作はすべて CLI で行う。コマンドの正本は `scripts/`（作成・削除は `stack.sh`、実行と確認は `batch.sh`）に置き、README からはそれを呼ぶだけにする。

### 全体方針

- **実行**: `aws stepfunctions start-execution`（`local` は LocalStack のエンドポイント）で、実行入力に `failAt` / `holdSeconds` を指定して起動する（`scripts/batch.sh <stage> run [failAt] [--hold-seconds <秒>]`）
- **確認**: 実行の状態は `describe-execution`、各 Lambda の出力は CloudWatch Logs、連携ファイルは S3、DLQ はメッセージ数で確かめる
- **ログ**: すべての Lambda は 1 行 1 JSON の構造化ログを出す。スタブの出力にも `stub` フィールドを付け、どの外部サービスへの送信を模したかを絞り込めるようにする
- **メール送信キューの DLQ の後始末**: DLQ のアラームは、DLQ を空にするまで `ALARM` のままで、その間の次の失敗は通知されない（04「リトライ」の「メールの送信の失敗の通知」）。通知を受けたら DLQ のメッセージ数（`scripts/batch.sh <stage> dlq`）と本文で失敗した実行名・配信対象を確かめ、対応したら DLQ を空にする（`aws sqs purge-queue`。`scripts/` にはまだ無い）。空にしなければ、保持期間（4 日）で消えるまで `ALARM` が続く。空にした後に `OK` に戻ることは、まだ観測していない（04「リトライ」）
