# CloudWatch アラーム解説

Amazon CloudWatch のうち、このプロジェクトが使う**メトリクスとアラーム**とは何か、どう評価されるか、このプロジェクトでなぜ・どう使うかをまとめる。ログ（CloudWatch Logs）は [Lambda 解説](lambda.md#ロググループ)で扱う。このプロジェクト固有の決定（数えるメトリクス・閾値・期間・欠損の扱い・窓・ウォームアップ）は [04 非機能仕様書](../04-non-functional-specification.md#リトライ)が正本で、アラームの実体は `infra/cdk/lib/batch-stack.ts`。本書はそれらを参照し、本文を複製しない。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-11-08 に確認）、このプロジェクトで確かめたことは 09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [CloudWatch のメトリクスとアラームとは](#cloudwatch-のメトリクスとアラームとは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## CloudWatch のメトリクスとアラームとは

AWS のサービスは、動いた結果を数値（**メトリクス**）として CloudWatch に送っている。SQS ならキューに送られたメッセージの数、Scheduler なら起動を試みた回数、のように、サービスごとに何を送るかが決まっている。こちらで何かを仕込まなくても、使えば送られる。

**アラーム**は、1 つのメトリクスを一定の期間ごとに集計し、閾値と比べて状態を決める仕組み。状態が変わったときに、通知や Lambda の呼び出しなどを起こせる。サーバーを持たない構成では、「何かが起きた」だけでなく「起きるはずのことが起きなかった」を検知する手段としても使う（下記「[起きなかったことを数えるアラーム](#起きなかったことを数えるアラーム)」）。

## 仕組み

### メトリクスを指す 4 つの要素

アラームが数えるメトリクスは、次の組で 1 つに決まる（公式。Scheduler・SQS のメトリクスのページの用語）。

| 要素 | 意味 | このプロジェクトの例 |
|---|---|---|
| 名前空間（namespace） | サービスごとの入れ物 | `AWS/SQS`・`AWS/Scheduler` |
| メトリクス名 | 何を数えたか | `NumberOfMessagesSent`・`InvocationAttemptCount` |
| ディメンション | どの対象のものか（名前と値の組） | SQS は `QueueName` だけ。Scheduler は `ScheduleGroup` だけ |
| 統計と期間 | どの長さの区間で、どう集計するか | 合計（`Sum`）を 5 分ごと・1 日ごと |

**ディメンションの粒度はサービスが決め、こちらでは変えられない。** Scheduler には Schedule 単位のディメンションが無く、group 単位でしか数えられない（公式「Monitoring Amazon EventBridge Scheduler with Amazon CloudWatch」）。このことが、このプロジェクトの「group に Schedule は 1 本だけ」という前提になっている（04「[リトライ](../04-non-functional-specification.md#リトライ)」）。

### アラームの状態

| 状態 | 意味（公式「Alarm evaluation」） |
|---|---|
| `OK` | メトリクスが閾値の内側にある |
| `ALARM` | メトリクスが閾値の外側にある |
| `INSUFFICIENT_DATA` | 作った直後・メトリクスが無い・判断に足りるデータが無い |

状態とは別に、評価そのものの状態（評価状態）もある。ウォームアップ中は `IN_WARM_UP` になり、設定の誤りは `EVALUATION_ERROR` になる（公式。`describe-alarms` で見える）。

### 評価の 3 つの設定

アラームを作るときは、状態を決めるための 3 つを指定する（公式「Alarm evaluation」）。

| 設定 | 意味 |
|---|---|
| 期間（`Period`） | 1 つのデータポイントを作る長さ（秒） |
| 評価期間（`EvaluationPeriods`） | 直近の何個のデータポイントを見るか（N） |
| アラームにするデータポイント数（`DatapointsToAlarm`） | N 個のうち、何個が閾値を超えたら `ALARM` にするか（M）。連続でなくてよい |

M と N を違う値にしたものを「M out of N」のアラームと呼ぶ。このプロジェクトの 3 つのアラームは、どれも N = 1（直近の 1 個だけを見る）。

期間が 1 分以上なら、アラームは**毎分**評価される。期間 5 分・評価期間 1 なら、5 分目の終わりに 1〜5 分目のデータで評価し、6 分目の終わりに 2〜6 分目で評価する（公式）。期間 × 評価期間が 1 日を超えるアラームは、1 時間に 1 回の評価になる（公式）。

### 欠損データの扱い

**メトリクスは、出来事が無ければデータ自体が出ないことがある。** そのときに「データが無い」をどう数えるかを `TreatMissingData` で決める（公式「Configuring how CloudWatch alarms treat missing data」）。

| 値 | 欠けたデータポイントを | 向いている場面 |
|---|---|---|
| `missing`（既定） | 評価する範囲がすべて欠けていれば `INSUFFICIENT_DATA` にする | — |
| `notBreaching` | 閾値の内側（正常）として数える | 異常のときだけデータが出るメトリクス |
| `breaching` | 閾値の外側（異常）として数える | 出るはずのデータが出ないこと自体が異常なとき |
| `ignore` | 今の状態を保つ | — |

欠損の扱いが効くのは、評価に要る数の実データが揃わないときだけ（公式）。データが揃っていれば、設定に関係なく実データで評価する。

### 評価の窓（スライドと壁時計）

評価に使うデータの区間（評価の窓）は、期間 × 評価期間の長さで、どこで区切るかを `EvaluationWindow` で選ぶ（公式「Alarm evaluation window」）。

| 窓 | 区切り方 | 向いている場面 |
|---|---|---|
| スライド（`SlidingWindow`。既定） | 評価のたびに 1 分ずつ進む。13:07〜14:07、次は 13:08〜14:08 | 異常をすぐに見つけたいとき |
| 壁時計（`WallClockWindow`） | 期間に合った時計の区切り（毎時 0 分・0 時・週の始まり）に揃える。タイムゾーンを指定できる（既定は UTC） | 1 日 1 回のバッチなど、暦の区切りで「その日に起きたか」を見たいとき |

公式は、日次のバックアップをスライドの窓で見ると、前日より少し遅れただけで 24 時間に 1 件も入らない区間ができ、誤って `ALARM` になる例を挙げている。壁時計の窓はその日ごとに独立して評価するため、これが起きない。代わりに、**区切りが終わるまでその区間のデータを評価に反映しない**ため、気づくのが遅くなる（公式）。

壁時計の窓で使える期間は 1 分・5 分・1 時間・1 日・1 週間に限られる。窓の種類を変えても評価の頻度は変わらず、変わるのは区切りの位置だけ（公式）。

### ウォームアップ

アラームを作った直後は、メトリクスがまだ出ていないことが多い。ウォームアップ（`WarmUpConfiguration`）を付けると、その間は評価せず `INSUFFICIENT_DATA` のままにし、アクションも起こさない（公式「Alarm warm-up periods」）。

| 設定 | 意味 |
|---|---|
| `WarmUpPeriodDurationInMinutes` | 1〜2,880 分（2 日） |
| `OnlyStartEvaluatingAfterWarmUpPeriodEnds` | `false`（既定）なら、評価の窓が埋まった時点で早めに終わる。`true` なら、データが来ても期間いっぱい待つ |

**公式のページの中で、ウォームアップが更新でも始まるかの記述が揺れている。** 冒頭は「作ったとき・更新したときに評価を遅らせる」と書き、同じページの「Change or end a warm-up period」は「作ったときに 1 回だけで、やり直さない」「期間が終わった後の更新では新しいウォームアップは始まらない」と書いている。このプロジェクトは後者に従って設計している（04「[リトライ](../04-non-functional-specification.md#リトライ)」）。更新したときの挙動は観測していない。

### 状態が変わったときだけ動く

アラームのアクション（SNS の通知・Lambda の呼び出し・EC2 の操作など）は、**状態が変わったときだけ**起き、同じ状態が何時間・何日続いても繰り返さない（公式「Alarm actions」。Auto Scaling のアクションは例外）。

アクションとは別に、CloudWatch はアラームの作成・更新・削除・状態の変化のたびに、EventBridge にイベント（`source` が `aws.cloudwatch`、`detail-type` が `CloudWatch Alarm State Change`）を出す。**この配信は保証されている**（公式「Alarm events and EventBridge」）。ルールのイベントパターンで、アラーム名と変化後の状態（`detail.state.value`）を絞って拾う。

## このプロジェクトで使う理由

元資料の構成は、**実行が失敗で終わったこと**しか通知に乗らない（ステートマシンの状態変化イベント → ルール → Slack 通知 Lambda）。実行が始まらない失敗と、実行が `SUCCEEDED` で終わった後の Consumer の失敗は、この経路では気づけない（[EventBridge 解説](eventbridge.md#通知が届かない経路が残っている)・元資料のリスク 1）。アラームは、その穴を埋めるために 3 つ置いている。

| アラーム | 検知すること | 数えるメトリクス | 正本 |
|---|---|---|---|
| `…-scheduler-dlq` | Scheduler がステートマシンを起動できず、呼び出しを DLQ へ送った | `AWS/SQS` の `NumberOfMessagesSent`（Scheduler の DLQ）の 5 分間の合計が 1 以上 | 04「[リトライ](../04-non-functional-specification.md#リトライ)」の「起動の失敗の通知」（#101） |
| `…-scheduler-missed-run` | Scheduler がその日（日本時間）の起動を 1 回も試みなかった（Schedule の無効化・削除など） | `AWS/Scheduler` の `InvocationAttemptCount`（group 単位）の 1 日の合計が 1 未満 | 04「[リトライ](../04-non-functional-specification.md#リトライ)」の「実行が始まらない日の通知」（#109） |
| `…-mail-dlq` | メールの送信に失敗し続けたメッセージが、メール送信キューの DLQ にある（実行は `SUCCEEDED`） | `AWS/SQS` の `ApproximateNumberOfMessagesVisible`（メール送信キューの DLQ）の 5 分間の最大が 1 以上 | 04「[リトライ](../04-non-functional-specification.md#リトライ)」の「メールの送信の失敗の通知」（#135） |

どれも、`ALARM` への変化を EventBridge のルールで拾い、実行の失敗と同じ Slack 通知 Lambda へ渡す。ルールはアラームごとに 1 つ（07「[アラームの状態変化イベント](../07-api-specification.md#アラームの状態変化イベントeventbridge--slack-通知-lambda)」）。

```text
Scheduler ──起動に失敗──▶ DLQ ──NumberOfMessagesSent──▶ アラーム（dlq）        ─┐
Scheduler ──起動を試みた回数（無ければデータ無し）──────▶ アラーム（missed-run）─┤
Consumer ──受信 3 回で失敗──▶ DLQ ──メッセージ数──────────▶ アラーム（mail-dlq）  ─┤
                                                                                 ├─ ALARM への変化 ─▶ EventBridge ルール ─▶ Slack 通知 Lambda
Step Functions ──FAILED / TIMED_OUT / ABORTED の状態変化イベント─────────────────┘
```

アラームは CDK で作る。ルールのイベントパターンにアラーム名を書くため、ルール・通知先と同じスタックに置いている。数える対象（DLQ のキュー名・Schedule group 名）は Terraform が作り、SSM から名前で参照する（09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」）。`…-scheduler-missed-run` は、壁時計の窓とウォームアップを CDK の L2（`cloudwatch.Alarm`）が持たないため、L1 の `CfnAlarm` で書いている（[CDK 解説](cdk.md#l1-と-l2-のコンストラクト)）。

## 特徴と制約

### 送信数で数えるか、メッセージ数で数えるか

DLQ を見張るとき、候補は 2 つある。どちらを選ぶかで、2 回目以降の失敗が通知されるかが変わる。

| メトリクス | 何を数えるか（公式「Available CloudWatch metrics for Amazon SQS」） | アラームの動き |
|---|---|---|
| `ApproximateNumberOfMessagesVisible` | いまキューにあるメッセージの数 | DLQ を空にするまで `ALARM` のまま。アクションは状態が変わったときだけなので、**次の失敗が通知されない** |
| `NumberOfMessagesSent` | キューに送られたメッセージの数 | 送られた期間だけ `ALARM` になり、次の期間に `OK` に戻る。次の失敗でもう一度 `ALARM` になる |

Scheduler の DLQ のアラームは、2 回目以降も通知するために送信数で数えている（04「[リトライ](../04-non-functional-specification.md#リトライ)」）。`dev` で、失敗を 3 回起こして 3 回とも通知されたこと、`ALARM` の 5 分後に `OK` に戻ったことを確かめた。`OK` に戻ったときの理由は「データが無い」ではなく、送信数 `0.0` のデータポイントだった（実 AWS、2026-10-21、#101。09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）。

**ただし、`NumberOfMessagesSent` は、`maxReceiveCount` を超えて自動で DLQ へ移ったメッセージを数えない**（公式。同じページの「Dead-letter queues (DLQs) and CloudWatch metrics」）。数えるのは `SendMessage` / `SendMessageBatch` で直接送られたものだけで、公式は DLQ の監視に `ApproximateNumberOfMessagesVisible` を勧めている。Scheduler の DLQ は Scheduler が送ってくるもので、`dev` で数えられることを確かめた（上記）。一方、メール送信キューの DLQ（Consumer の失敗）は redrive で自動で移るため、公式の記述どおりなら、**同じ形のアラームを流用すると、失敗しても `ALARM` にならない**。そのため `…-mail-dlq` は公式の勧めどおりメッセージ数で数え、DLQ を空にするまで `ALARM` のままになることを受け入れた（04「[リトライ](../04-non-functional-specification.md#リトライ)」の「メールの送信の失敗の通知」。#135）。CDK の UT で、送信数に戻させないよう固定している。

### 起きなかったことを数えるアラーム

`…-scheduler-missed-run` は「起動を試みた回数が 0 の日」を検知する。起動を試みなかった日は、**メトリクスのデータ自体が出ない**。そのため、普通のアラームとは設定の向きが逆になる。

| 設定 | 普通のアラーム（例: DLQ） | 起きなかったことを数えるアラーム |
|---|---|---|
| 比較 | 閾値以上で `ALARM`（`GreaterThanOrEqualToThreshold`） | 閾値未満で `ALARM`（`LessThanThreshold`） |
| 欠損の扱い | `notBreaching`（データが無い＝何も起きていない＝正常） | `breaching`（データが無い＝起動しなかった＝異常） |
| 窓 | スライド（すぐ気づきたい） | 壁時計の 1 日（日本時間の 0 時区切り。起動の時刻の揺れで誤通知しない） |
| ウォームアップ | 無し | 2 日。作った直後に評価する 1 日は作る前の日でデータが無く、そのままだと作った時点で `ALARM` になる |

壁時計の窓の区切り（タイムゾーン）を Schedule と揃えないと、9:00 の起動が評価の 1 日をまたいで数えられ、起動した日にも `ALARM` になる（`batch-stack.ts` の `SCHEDULE_TIMEZONE`）。

このアラームの評価は、`dev` では観測していない。観測したのはウォームアップ中の状態（`INSUFFICIENT_DATA`・`IN_WARM_UP`）だけで、壁時計の窓が日本時間の 0 時で区切ること・起動しなかった日に `ALARM` になることは公式の記述に基づく（04「[リトライ](../04-non-functional-specification.md#リトライ)」の「未観測」。観測は #116）。

### 通知は状態が変わった最初の 1 回だけ

EventBridge のイベントも、アクションと同じく状態が変わったときにだけ出る。

- **Scheduler の DLQ のアラーム**: 送信数で数えるため、失敗のたびに `OK` → `ALARM` に変わり、毎回通知される（上記）
- **メール送信キューの DLQ のアラーム**: メッセージ数で数えるため、DLQ を空にするまで `ALARM` のままで、その間の次の失敗は通知されない。DLQ を確かめて空にすれば `OK` に戻り、次の失敗でもう一度通知されるはずだが、未観測（LocalStack では、空にしても 15 分以上 `ALARM` のままだった。04「[リトライ](../04-non-functional-specification.md#リトライ)」・03「[操作方針](../03-functional-specification.md#操作方針)」）
- **起きなかったことのアラーム**: 起動しない日が続く間は `ALARM` のままで、通知は最初の 1 日だけ。起動した日の後に `OK` に戻り、次の欠けでもう一度通知される。「まだ直っていない」状態を表すものとして、このままにしている（04「[リトライ](../04-non-functional-specification.md#リトライ)」）

どのアラームも、ルールのイベントパターンで `ALARM` への変化だけを拾い、`OK` への変化は通知しない。

### メトリクスは欠けうる

Scheduler のメトリクスは**ベストエフォート**で、遅れることも、届かないこともある（公式「Monitoring Amazon EventBridge Scheduler with Amazon CloudWatch」）。`…-scheduler-missed-run` は欠損を `breaching` で数えるため、メトリクスが欠けた日は、起動していても `ALARM` になりうる。見逃すより誤通知の側に倒している。通知を受けたら、その日の定時の起動の実行（実行名が UUID）があるかを `list-executions` で確かめる（04「[リトライ](../04-non-functional-specification.md#リトライ)」）。

SQS のメトリクスについては、`NumberOfMessagesSent` が欠けたときの振る舞いを観測していない（[EventBridge 解説](eventbridge.md#通知が届かない経路が残っている)）。

### アラームのアクションではなく、ルールを経由している

アラームは、アクションで Lambda を直接呼べる（公式「Alarm actions」）。このプロジェクトは、アクションを使わず、状態変化イベントを EventBridge のルールで拾って Slack 通知 Lambda を呼んでいる。この形を選んだ理由は、仕様書・#101・PR #110 に記録が無い。結果として、Slack 通知 Lambda は実行の失敗もアラームも、EventBridge のイベントとして同じ入口で受け取っている（07「[アラームの状態変化イベント](../07-api-specification.md#アラームの状態変化イベントeventbridge--slack-通知-lambda)」）。ルールから Lambda を呼ぶ権限の付き方は [EventBridge 解説](eventbridge.md#ルールのターゲットへの配信と再試行)を参照。

### 料金

標準の解像度のアラームは、存在する間、月額で課金される。このデモは 2 つで、`dev` は検証の間だけ存在する。単価と、その出どころ（公式の料金ページの該当箇所は読めていない）は 09「[費用](../09-architecture-specification.md#費用)」を参照。

## LocalStack との違い

| 違い | 正本 |
|---|---|
| DLQ のアラームは評価され、送信で `ALARM` になり、`OK` にも戻る。ただし、その状態変化を **EventBridge に出さない**。ルール → Lambda の経路は、同じ形のイベントを `put-events` で入れて確かめる | 09「[LocalStack での検証結果](../09-architecture-specification.md#localstack-での検証結果)」 |
| 壁時計の窓とウォームアップは、CLI で直接作れば受け付けるが、評価に反映されないように見える。CloudFormation（CDK）で作ると、2 つの設定そのものが落ちる | 09「[LocalStack での検証結果](../09-architecture-specification.md#localstack-での検証結果)」・04「[リトライ](../04-non-functional-specification.md#リトライ)」 |
| Scheduler が定時に起動しないため、`InvocationAttemptCount` が出ない。起きなかったことのアラームは、`local` では評価を確かめられない | 同上 |

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| 1 回目の失敗は通知されたが、2 回目以降が通知されない | アラームが `ALARM` のまま戻っていない。アクション・状態変化イベントは状態が変わったときだけ出る。キューのメッセージ数で数えているなら、送信数で数えるか、DLQ を空にする運用にする |
| DLQ にメッセージが溜まっているのに、送信数のアラームが `ALARM` にならない | redrive（`maxReceiveCount` 超え）で自動で移ったメッセージは `NumberOfMessagesSent` に数えられない（公式）。DLQ の監視は `ApproximateNumberOfMessagesVisible` で行う |
| アラームを作った直後に `ALARM` になり、通知が飛んだ | 作る前の区間にデータが無く、欠損を `breaching` で数えた。ウォームアップを付ける |
| 毎日動いているのに、日次のアラームがときどき `ALARM` になる | スライドの窓で、起動の時刻が前日より遅れ、24 時間の窓にデータが入らなかった。壁時計の窓にする。メトリクスがベストエフォートで欠けた場合も起きうる |
| 壁時計の窓の 1 日が、意図した日付の区切りとずれる | タイムゾーンを指定していない（既定は UTC）。Schedule と同じタイムゾーンを指定する |
| 1 本の Schedule を止めても、起きなかったことのアラームが `ALARM` にならない | `InvocationAttemptCount` は group 単位でしか数えられない。同じ group に別の Schedule があれば、合計が 1 以上になる |
| `local` でアラームが `ALARM` になったのに、Slack 通知 Lambda が呼ばれない | LocalStack はアラームの状態変化を EventBridge に出さない。`put-events` で同じ形のイベントを入れて経路を確かめる |

## 参考資料

- [Alarm evaluation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-evaluation.html)（状態・評価状態・期間・評価期間・M out of N・評価の頻度）
- [Configuring how CloudWatch alarms treat missing data](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html)
- [Alarm evaluation window](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-evaluation-window.html)（スライドと壁時計・使える期間・タイムゾーン）
- [Alarm warm-up periods](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-warm-up.html)
- [Alarm actions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-actions.html)（状態が変わったときだけ動く）
- [Alarm events and EventBridge](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch-and-eventbridge.html)（状態変化イベントの形・配信の保証）
- [Available CloudWatch metrics for Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)（`NumberOfMessagesSent` と DLQ）
- [Monitoring Amazon EventBridge Scheduler with Amazon CloudWatch](https://docs.aws.amazon.com/scheduler/latest/UserGuide/monitoring-cloudwatch.html)（`InvocationAttemptCount`・ディメンション・ベストエフォート）
