# EventBridge 解説

Amazon EventBridge のうち、このプロジェクトが使う 2 つ（**EventBridge Scheduler** と **EventBridge のルール**）とは何か、どう動くか、このプロジェクトでなぜ・どう使うかをまとめる。このプロジェクト固有の決定（起動の時刻・実行入力・イベントパターン・権限）は [02 要件仕様書](../02-requirements-specification.md#f-1-定時起動)・[06 セキュリティ仕様書](../06-security-specification.md#認可権限制御)・[07 API 仕様書](../07-api-specification.md#状態変化イベントeventbridge--slack-通知-lambda)・[09 アーキテクチャ仕様書](../09-architecture-specification.md#iac-の責務分担)が正本で、本書はそれらを参照し、本文を複製しない。起動される側（実行・状態変化イベント）は [Step Functions 解説](step-functions.md)、呼ばれる側（非同期の呼び出し）は [Lambda 解説](lambda.md)を前提にする。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-10-17 に確認）、このプロジェクトで確かめたことは 09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [EventBridge とは](#eventbridge-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## EventBridge とは

AWS のイベント（「何かが起きた」という通知）と、決まった時刻の起動を扱うサービス群の名前。EventBridge の名前の下に、API もリソースも別のサービスがいくつか並んでいる。このプロジェクトが使うのは次の 2 つで、**役割が逆向き**になっている。

| サービス | 役割 | きっかけ | API の名前空間 | このプロジェクトでの使い方 |
|---|---|---|---|---|
| EventBridge Scheduler | 決まった時刻に、ターゲットの API を**呼びに行く** | 時刻（cron・rate・1 回限り） | `scheduler` | 毎日 9:00 にステートマシンを起動する |
| EventBridge のルール | イベントバスに届いたイベントを**受けて**、条件に合うものをターゲットへ振り分ける | イベント | `events` | 実行の失敗のイベントを Slack 通知 Lambda へ渡す |

Scheduler はイベントバスを通らない。ルールにも決まった時刻に動かす機能（スケジュールのルール）があるが、公式はこれを legacy とし、Scheduler を使うよう勧めている（公式「Creating a scheduled rule (legacy)」）。スケジュールのルールは UTC だけで評価され、Scheduler はタイムゾーンを指定できる。

## 仕組み

### Scheduler: Schedule とターゲット

Schedule は「いつ（式とタイムゾーン）」「何を（ターゲット）」「どの権限で（実行ロール）」の組で、Schedule group という入れ物に入る（公式）。

| 要素 | 内容 |
|---|---|
| 式 | `cron(...)`（決まった時刻の繰り返し）・`rate(...)`（一定間隔）・`at(...)`（1 回限り）の 3 種類 |
| タイムゾーン | IANA のタイムゾーン名。省略すると UTC |
| ターゲット | 呼ぶ API。よく使う API を ARN だけで指定できる **templated target**（Lambda の `Invoke`・SQS の `SendMessage`・Step Functions の `StartExecution` など）と、任意の API を指定する **universal target**（`arn:aws:scheduler:::aws-sdk:<サービス>:<操作>`）がある |
| `Input` | ターゲットに渡す本文（最大 256 KB）。Lambda・Step Functions・EventBridge の templated target では整った JSON でなければならない。**省略すると、Scheduler が既定の通知を渡す**（公式「Target」） |
| 実行ロール | Scheduler が引き受けて、ターゲットの API を呼ぶ IAM ロール |
| `FlexibleTimeWindow` | 起動の時刻に幅を持たせるか。**指定が必須**で、幅を持たせないなら `OFF`、持たせるなら `FLEXIBLE` と最大の幅（分）を書く。幅を持たせると、その幅の中で起動が分散される（公式） |
| 再試行・DLQ | ターゲットの呼び出しに失敗したときの再試行と、再試行し尽くしたときの送り先（下記） |

Schedule group は、Schedule をまとめてタグを付けるための入れ物（公式）。グループを指定しないと `default` に入る。

### cron 式とタイムゾーン

Scheduler の cron 式は **6 つの項目**（分・時・日・月・曜日・年）で、Unix の crontab（5 項目）と違って年がある（公式「Schedule types」）。

```text
cron(分 時 日 月 曜日 年)
cron(0  9  *  *  ?    *)   ← 毎日 9:00
```

- 日と曜日の両方に `*` は書けない。片方に `*` を書いたら、もう片方は `?`（どれでもよい）にする
- 曜日は `1-7`（または `SUN-SAT`）で、**1 が日曜日**。crontab（0 が日曜日）と数え方が違う
- 起動の精度は **60 秒**。`FlexibleTimeWindow` が `OFF` でも、1:00 の Schedule は 1:00:00〜1:00:59 のどこかで起動する（公式）
- 夏時間のあるタイムゾーンでは自動で調整される。時計が進む日に存在しない時刻の起動は飛ばされ、時計が戻る日に 2 回現れる時刻の起動は 1 回だけ行われる（公式）。夏時間の無いタイムゾーン・UTC では調整されない

`at()` の Schedule は 1 回だけ起動する。**起動した後も Schedule は残り、アカウントの上限に数えられる**ため、公式は終わった Schedule を消すよう勧めている。作るときに、起動の後で自動で消す設定（`ActionAfterCompletion: DELETE`）も選べる。

### Scheduler の再試行と配信

Scheduler の配信は**少なくとも 1 回**で、「ターゲットから応答があった配信が少なくとも 1 回成功する」ことを保証する（公式「What is Amazon EventBridge Scheduler?」）。ターゲットの呼び出しが再試行できるエラーで失敗すると、指数的に間隔を広げて呼び直す。

| `RetryPolicy` の項目 | 範囲（公式） | 既定 |
|---|---|---|
| `MaximumRetryAttempts` | 0〜185 回 | 185 回 |
| `MaximumEventAgeInSeconds` | 60〜86,400 秒（24 時間） | 24 時間 |

既定の値は、Scheduler のユーザーガイドと API リファレンスでは上限としてしか書かれておらず、既定値として書いているのは CDK の L2 のドキュメント（`aws-scheduler-targets` の `retryAttempts` / `maxEventAge`）だった。このプロジェクトは L1 の `CfnSchedule` を使うため、省略すると効くのは CDK の既定ではなくサービス側の既定になる。サービス側の既定は、`dev` の CloudTrail の記録から **185 回・24 時間**と分かった（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）。今は同じ値を CDK で明示している（#92）。

再試行し尽くした呼び出しは、DLQ（SQS の**標準**キュー。FIFO は使えない）を設定していれば、エラーの内容と一緒にそこへ送られる。DLQ が無ければ残らない。universal target では、`Input` の中身が作成時に検証されず、Schedule は作れても毎回の起動で失敗する（公式「Configuring a schedule's dead-letter queue」）。

`Input` には、起動のたびに Scheduler が値を埋めるキーワード（コンテキスト属性）を書ける（公式）。

| キーワード | 中身 |
|---|---|
| `<aws.scheduler.schedule-arn>` | Schedule の ARN |
| `<aws.scheduler.scheduled-time>` | 予定の時刻（例: `2022-03-22T18:59:43Z`） |
| `<aws.scheduler.execution-id>` | 呼び出しの試行ごとに Scheduler が付ける ID（例: `d32c5kddcf5bb8c3`） |
| `<aws.scheduler.attempt-number>` | その起動の何回目の試行か |

### ルール: イベントバスとイベントパターン

AWS のサービスが出すイベントは、アカウント・リージョンごとの**既定のイベントバス**（`default`）に届く。ルールはイベントバスに付き、届いたイベントのうち**イベントパターン**に合うものを、ターゲット（1 つのルールに最大 5 つ）へ送る（公式「Event bus targets」）。

イベントパターンは、合わせたいイベントと同じ形の JSON で書く。

```json
{
  "source": ["aws.states"],
  "detail-type": ["Step Functions Execution Status Change"],
  "detail": { "status": ["FAILED", "TIMED_OUT", "ABORTED"] }
}
```

照合の規則（公式「Event pattern syntax」）:

| 規則 | 意味 |
|---|---|
| パターンに書いた項目は**すべて**合う必要がある | 項目どうしは AND。項目の入れ子の形もイベントと同じでなければならない |
| 配列の値は**どれか 1 つ**に合えばよい | 値は必ず配列で書く。配列の中は OR |
| パターンに書かない項目は見ない | 書かなかった項目は `"*": "*"` と同じ扱い。絞り込みたいものはすべて書く |
| 文字列は 1 文字ずつ完全一致 | 大文字・小文字を区別し、正規化しない |
| 数値は文字列として比べる | `300` と `300.0` は別の値 |

完全一致のほかに、前方一致（`prefix`）・否定（`anything-but`）・項目の有無（`exists`）・数値の範囲（`numeric`）などの比較演算子も書ける。パターンが実際のイベントに合うかは、`TestEventPattern` API（CLI では `aws events test-event-pattern`）で確かめられる。

### ルールのターゲットへの配信と再試行

ターゲットへの配信が再試行できるエラーで失敗すると、EventBridge は既定で **24 時間・最大 185 回**、指数的な間隔とジッターを付けて送り直す。再試行し尽くしたイベントは**捨てられる**。捨てたくなければ、ターゲットに DLQ（SQS）を付ける（公式「How EventBridge retries delivering events」）。

ターゲットが Lambda のとき、EventBridge は関数を**非同期で呼ぶ**（公式のターゲットの一覧に「Lambda function (ASYNC)」とある）。配信は Lambda がイベントを受け付けた時点で終わり、その後に関数が失敗したときのやり直しは、Lambda の非同期の再試行（既定 2 回）が担う（[Lambda 解説](lambda.md#失敗したときに誰がやり直すか)）。つまり、**やり直しの層が 2 つある**。

| 失敗したところ | やり直す主体 | 既定 |
|---|---|---|
| EventBridge → Lambda の呼び出し（Lambda が受け付けない） | EventBridge のルール | 24 時間・最大 185 回 |
| 受け付けた後の関数の実行 | Lambda の非同期の呼び出し | 最大 2 回 |

ルールから Lambda を呼ぶ権限は、実行ロールではなく、**関数側のリソースベースポリシー**（`events.amazonaws.com` に `lambda:InvokeFunction` を許す）で与えるのが基本（公式「Using resource-based policies」。実行ロールを付けることもできる）。

ターゲットを追加・変更した直後は、すぐには反映されないことがある（公式）。

## このプロジェクトで使う理由

元資料の構成のうち、起動のきっかけ（crontab の代わり）を Scheduler、失敗の通知（監視ツールのアラート連携の代わり）をルールで動かす（[元資料](../references/aws-batch-architecture.md)・09「[システム構成図](../09-architecture-specification.md#システム構成図)」）。Step Functions は自分では通知しないため、実行の状態変化イベントをルールで拾う。

| 使っているもの | このプロジェクトでの使い方 | 正本 |
|---|---|---|
| Schedule | 毎日 9:00（`Asia/Tokyo`）に、templated target でステートマシンの `StartExecution` を呼ぶ。`Input` は `{}`、`FlexibleTimeWindow` は `OFF` | 02「[F-1](../02-requirements-specification.md#f-1-定時起動)」・07「[実行入力](../07-api-specification.md#実行入力startexecution-の-input)」 |
| Schedule group | Terraform が作り、Schedule 定義（CDK）は SSM から名前で参照する | 09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」 |
| Scheduler の実行ロール | Terraform が作る。`states:StartExecution` を、このステートマシン 1 つにだけ許す。DLQ への `sqs:SendMessage` も、Scheduler の DLQ 1 つにだけ許す | 06「[認可](../06-security-specification.md#認可権限制御)」 |
| Scheduler の DLQ | Terraform が SQS の標準キューで作り、Schedule の `DeadLetterConfig`（CDK）が SSM から参照する。起動に失敗した呼び出しを受ける（#101） | 04「[リトライ](../04-non-functional-specification.md#リトライ)」・07「[Scheduler の DLQ のメッセージ](../07-api-specification.md#scheduler-の-dlq-のメッセージ)」 |
| ルール | 既定のイベントバスで 2 つ置く。このステートマシンの `FAILED` / `TIMED_OUT` / `ABORTED` と、Scheduler の DLQ のアラームの `ALARM` への変化だけを拾い、どちらも Slack 通知 Lambda へ渡す。CDK が通知先と同じスタックに置く | 02「[F-5](../02-requirements-specification.md#f-5-失敗通知)」・07「[状態変化イベント](../07-api-specification.md#状態変化イベントeventbridge--slack-通知-lambda)」「[アラームの状態変化イベント](../07-api-specification.md#アラームの状態変化イベントeventbridge--slack-通知-lambda)」 |
| ルールから Lambda への権限 | 関数側のリソースベースポリシー。CDK がターゲットの設定のときに付ける（IAM ロールは変えない） | 06「[認可](../06-security-specification.md#認可権限制御)」 |
| Slack 通知 Lambda の失敗 | 対象外のイベントはエラーにせず正常に終える。通知そのものの失敗は投げ直し、Lambda の非同期の再試行（2 回）に任せる | 03「[Slack 通知 Lambda](../03-functional-specification.md#slack-通知-lambdanotify-slack)」・04「[リトライ](../04-non-functional-specification.md#リトライ)」 |

Scheduler の再試行は、サービスの既定と同じ値（185 回・24 時間）を CDK で明示している（04「[リトライ](../04-non-functional-specification.md#リトライ)」）。Scheduler の DLQ は #101 で付けた。ルールのターゲットの再試行・DLQ は、CDK で設定しておらず、既定のまま（上記）。

## 特徴と制約

### 定時の起動は、予定の時刻から数十秒遅れる

`dev` で 2 回確かめ、予定の時刻から 7 秒後（1 回限りの Schedule）と 43 秒後（定時の Schedule）に実行が始まった（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）。公式の「60 秒の精度」（上記）の範囲に収まっている。

9:00 ちょうどに動くことを前提にした処理（例: 9:00:00 時点のデータを取る）は置けない。予定の時刻が必要なら、実行の開始時刻ではなく、`<aws.scheduler.scheduled-time>` を `Input` に埋めて渡す。このプロジェクトは時刻を使わないため、`Input` は `{}` のまま。

`cron(0 9 * * ? *)` そのものの発火は見ていない。確かめたのは、時・分だけを数分先に変えた同じ形の式（09・02「受け入れ条件」）。`Asia/Tokyo` は夏時間が無いため、起動が飛ばされたり、調整されたりすることは無い。

### 定時の起動の実行名を、誰が付けているか

`dev` の定時の起動では、実行名が UUID（例: `d56acd67-9cb6-4a25-962d-bb6d38fc8890`）だった。**この UUID は Scheduler が `StartExecution` の `name` で渡している**。CloudTrail の `StartExecution` イベントで、呼び出し元が Scheduler の実行ロール、`requestParameters.name` がその UUID だった（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」・#92）。

公式の記述からは、Step Functions が付けた可能性が高いと読めていた。Scheduler の templated target には実行名を指定する項目が無く（公式「Target」）、`StartExecution` は名前を指定しないと Step Functions が UUID を付ける（公式「StartExecution」）。どちらも事実だが、templated target でも Scheduler は名前を自分で付けて渡していた。**公式の記述を組み合わせた推論は、観測と逆になることがある。**

名前が効くのは、Scheduler が同じ起動を 2 回呼んだとき。Standard の `StartExecution` は**同じ名前・同じ入力**のときだけ冪等になる（[Step Functions 解説](step-functions.md#実行名と冪等性)）。

- **やり直しで同じ名前を使うなら**、2 回目は実行中の同じ実行を返すか（実行中）、`ExecutionAlreadyExists` になる（終わった後）。実行は 1 つで済む
- **名前が変わるなら**、別の実行がもう 1 つ始まる。投入 Lambda の重複排除 ID は `<実行名>:<配信対象 ID>` で、実行名が違えば SQS FIFO も重複とみなさないため、メールが二重に送られる（03「[投入 Lambda](../03-functional-specification.md#投入-lambdaenqueue)」）

**どちらになるかは、公式に記述が無く、観測もしていない**（観測した 2 回はどちらも 1 回目で成功した）。このプロジェクトは、防がないと決めた（04「[リトライ](../04-non-functional-specification.md#リトライ)」）。

防ぐなら、universal target（`arn:aws:scheduler:::aws-sdk:sfn:startExecution`）で `Name` を渡し、起動ごとに決まった値にする必要がある（試していない）。ただし、Scheduler が埋められる値のうち、予定の時刻（`<aws.scheduler.scheduled-time>`）は `:` を含んで実行名に使えず（公式「StartExecution」）、`<aws.scheduler.execution-id>` は試行ごとに変わる（公式「Adding context attributes」）。そのため、値を変換する Lambda などを間に足すことになる。実行名はこのプロジェクトでは文字を制限して検証している（06「[入力バリデーション](../06-security-specification.md#入力バリデーション)」）。

### `Input` を省略しない

templated target の `Input` を省略すると、Scheduler の既定の通知が実行入力になる（上記）。実行入力のキーはそのままタスク入力に入り、タスク入力のスキーマが未知のキーを拒否するため、既定の通知がキーを持つ JSON なら、実行は `ValidationError` で失敗する（07「[タスク入力](../07-api-specification.md#タスク入力投入データ連携-lambda-共通)」。既定の通知の中身は確かめていない）。このプロジェクトは `{}` を明示している（07「[実行入力](../07-api-specification.md#実行入力startexecution-の-input)」）。

### イベントパターンで、対象のステートマシンと状態を絞る

状態変化イベントは、**アカウント・リージョンのすべての Standard のステートマシン**から、同じ既定のイベントバスに届く。検証用のアカウントは他のプロジェクトと共用している（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）ため、`stateMachineArn` で絞らないと、他のステートマシンの失敗まで通知される。

状態の絞り込みは、通知したい 3 つを列挙する形にしている。`SUCCEEDED` だけでなく `RUNNING` なども、パターンに書いていないので届かない。`anything-but` で `SUCCEEDED` を除く書き方にすると、`RUNNING` や、将来足される状態まで通知される。

Slack 通知 Lambda も、届いたイベントを検証し直す（06「[入力バリデーション](../06-security-specification.md#入力バリデーション)」）。ルールの絞り込みとは別に持つのは、呼び出し元が AWS のサービスでも、形式を信頼しないため。日時の項目は形が環境で違うため、検証しない（下記「LocalStack との違い」）。

### 通知が届かない経路が残っている

失敗の通知は、次のどこで止まっても、気づく仕組みが無い。

| 止まるところ | 公式の振る舞い | このプロジェクト |
|---|---|---|
| Scheduler → ステートマシン（起動そのもの） | 24 時間・185 回で、DLQ が無ければ捨てられる（上記） | **#101 で手当てした。** DLQ へ送られた呼び出しを、DLQ のアラーム → ルール → Slack 通知 Lambda で通知する（04「[リトライ](../04-non-functional-specification.md#リトライ)」の「起動の失敗の通知」）。`dev` で端から端まで確かめた。実行ロールの権限の誤り（`AccessDeniedException`）とステートマシンの削除（`StateMachineDoesNotExist`）はやり直されず、予定の約 4 分後に通知された。やり直せるエラーでは、通知はやり直しを使い切った後（最大 24 時間後）になる（どのエラーがやり直されるかは一部だけ観測。09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」） |
| Schedule そのもの（無効化・削除） | 呼び出しが起きない | **#109 で手当てした。** Scheduler が起動を試みた回数（`AWS/Scheduler` の `InvocationAttemptCount`）を日本時間の 1 日ごとに数え、0 回の日をアラーム → ルール → Slack 通知 Lambda で通知する（04「[リトライ](../04-non-functional-specification.md#リトライ)」の「実行が始まらない日の通知」）。気づくのは翌 0 時過ぎで、メトリクスが欠けた日は誤通知になる。`local` ではルール → 通知の経路だけを確かめた。評価のふるまいは `dev` で未確認 |
| CloudWatch アラーム → イベントバス | アラームの状態変化イベントの EventBridge への配信は保証される（公式「Alarm events and EventBridge」） | LocalStack は出さない（下記）。アラームのメトリクス（SQS の `NumberOfMessagesSent`）の欠けは未観測 |
| Step Functions → イベントバス | 状態変化イベントはベストエフォート（[Step Functions 解説](step-functions.md#状態変化イベントだけに通知を頼っている)） | 欠けたときの手当ては無い |
| ルール → Lambda | 24 時間・185 回で捨てられる | DLQ は無い |
| Lambda の関数 | 2 回の再試行で捨てられる | 失敗したイベントの送り先・DLQ は無い |

Consumer 側の失敗（DLQ 行き）が通知に乗らないことは、元資料のリスクとして意図的に残している（02「[F-5](../02-requirements-specification.md#f-5-失敗通知)」）。上の表は、それとは別に、通知の経路そのものが失敗を落としうる箇所。

### 料金

Scheduler は呼び出し 100 万回あたり $1.00 で、毎月 1,400 万回は無料（公式）。このプロジェクトの定時の起動は 1 日 1 回で、無料の範囲に収まる。ルールの側の料金（AWS のサービスが既定のイベントバスに出すイベント）は、料金ページでは AWS の管理イベントの取り込みが無料と書かれているが、状態変化イベントについての明記は確認できなかった（未確認）。

## LocalStack との違い

| 違い | 正本 |
|---|---|
| Scheduler が定時に起動しない。`at()` / `rate()` / `cron()` のどれも、ターゲットが呼ばれなかった。作成・取得などの API は動くため、デプロイは通る。`local` では `scripts/batch.sh local run` で手動で起動する | 09「[LocalStack での検証結果](../09-architecture-specification.md#localstack-での検証結果)」 |
| 状態変化イベントはルールに届き、`SUCCEEDED` はイベントパターンで除外される | 09「[LocalStack での検証結果](../09-architecture-specification.md#localstack-での検証結果)」 |
| 状態変化イベントの日時の項目（`startDate` / `stopDate`）が、実 AWS ではエポックミリ秒、LocalStack では ISO 8601 の文字列で届く。通知 Lambda が日時を数値として検証していて、LocalStack で失敗通知を捨てていた | 07「[状態変化イベント](../07-api-specification.md#状態変化イベントeventbridge--slack-通知-lambda)」・教訓ログ「[失敗通知 Lambda が、通知に使わない日時項目の形の違いで失敗通知を捨てていた](../lessons-learned.md#2026-10-09-失敗通知-lambda-が通知に使わない日時項目の形の違いで失敗通知を捨てていた)」 |
| CloudWatch アラームは評価され、DLQ への送信で `ALARM` になるが、その状態変化を EventBridge に出さない。ルール → Lambda の経路は、同じ形のイベントを `put-events` で入れて確かめる | 09「[LocalStack での検証結果](../09-architecture-specification.md#localstack-での検証結果)」 |
| LocalStack は既定で IAM のポリシーを評価しないため、Scheduler の実行ロールの権限が足りなくても分からない。最小権限で動くことは `dev` で確かめる | 06「[認可](../06-security-specification.md#認可権限制御)」 |

LocalStack 全体の性質は [LocalStack 解説](localstack.md#本物の-aws-との違い)を参照。

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| cron 式が作成時にエラーになる | 項目が 5 つ（crontab の形）になっている、または日と曜日の両方が `*`。年を足して 6 項目にし、片方を `?` にする |
| 曜日指定の Schedule が 1 日ずれる | 曜日の数え方が crontab と違う（Scheduler は 1 が日曜日）。`MON-FRI` のように名前で書く |
| 9:00 に動くはずが、日本時間の 18:00 に動く | タイムゾーンを省略して UTC で評価されている。`ScheduleExpressionTimezone` を指定する |
| `FlexibleTimeWindow` を書かずに作れない | 必須の項目。幅が要らなければ `{"Mode": "OFF"}` を書く |
| `at()` の Schedule が溜まり、上限に当たる | 起動した後も残る。`ActionAfterCompletion: DELETE` で作るか、手で消す |
| ステートマシンが起動されない | 実行ロールに `states:StartExecution` が無い、または信頼ポリシーの主体が `scheduler.amazonaws.com` でない。LocalStack ではこの誤りが見えない（上記） |
| universal target の Schedule が毎回失敗する | `Input` の中身は作成時に検証されない。DLQ を付けて、エラーの内容を読む |
| ルールにイベントが届かない | パターンの値が配列になっていない、大文字・小文字が違う、入れ子の形が違う。`aws events test-event-pattern` で実際のイベントと照らす |
| 他のステートマシンの失敗まで通知される | `stateMachineArn` で絞っていない。既定のイベントバスには、アカウントのすべての状態変化イベントが届く |
| 通知 Lambda が、LocalStack では動くのに実 AWS で落ちる（またはその逆） | 日時の項目の形が環境で違う。通知に使わない項目は検証しない |
| ターゲットを変えた直後のイベントが、古いターゲットに届く | ターゲットの変更の反映には少し時間がかかる（公式） |

## 参考資料

- [What is Amazon EventBridge Scheduler?](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)（少なくとも 1 回の配信）
- [Schedule types in EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)（cron・rate・at・タイムゾーン・夏時間・60 秒の精度）
- [Configuring flexible time windows](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-flexible-time-windows.html)
- [Using templated targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-templated.html)・[Target](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_Target.html)（`Input` の既定）・[RetryPolicy](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_RetryPolicy.html)
- [Configuring a schedule's dead-letter queue](https://docs.aws.amazon.com/scheduler/latest/UserGuide/configuring-schedule-dlq.html)
- [Adding context attributes](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-context-attributes.html)
- [Creating a scheduled rule (legacy)](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html)（Scheduler を勧める記述・UTC）
- [Amazon EventBridge event patterns](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html)・[Event pattern syntax](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-pattern.html)
- [Event bus targets](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html)（Lambda は非同期・1 ルール 5 ターゲット）
- [How EventBridge retries delivering events](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html)
- [Using resource-based policies for Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html)
- [StartExecution](https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html)（名前を省略したときの UUID・冪等性）
- [Recording Step Functions API calls with AWS CloudTrail](https://docs.aws.amazon.com/step-functions/latest/dg/procedure-cloud-trail.html)（`StartExecution` は管理イベントで、イベント履歴に 90 日残る）
- [Amazon EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/)
