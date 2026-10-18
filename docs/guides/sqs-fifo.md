# SQS FIFO 解説

Amazon SQS の FIFO キューとは何か、標準キューと何が違うか、このプロジェクトでなぜ・どう使うかをまとめる。このプロジェクト固有の決定（グループ ID・重複排除 ID・タイムアウト・受信回数・保持期間）は [03 機能仕様書](../03-functional-specification.md#consumer-lambdaconsumer)・[04 非機能仕様書](../04-non-functional-specification.md#パフォーマンス要件)・[05 データ仕様書](../05-data-specification.md#メールメッセージmailmessage)・[07 API 仕様書](../07-api-specification.md#sqs-メッセージ本文)が正本で、本書はそれらを参照し、本文を複製しない。キューを読む側（イベントソースマッピング・部分バッチ応答）は [Lambda 解説](lambda.md#sqs-をイベントソースにしたとき)を前提にする。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-10-18 に確認）、このプロジェクトで確かめたことは 08・09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [SQS FIFO とは](#sqs-fifo-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## SQS FIFO とは

Amazon SQS（Simple Queue Service）は、メッセージを送る側と受け取る側の間に置く、マネージドなキュー。送る側はキューに積んで終わり、受け取る側は自分の速さで取り出して処理し、処理し終えたら消す。間にキューがあるため、片方が遅れても落ちても、もう片方は止まらない。

キューには**標準キュー**と **FIFO キュー**の 2 種類があり、作った後に変えられない（FIFO はキューの名前の末尾が `.fifo` でなければならない。公式）。

| 観点 | 標準キュー | FIFO キュー |
|---|---|---|
| 順序 | ベストエフォート（入れ替わりうる） | **メッセージグループの中では厳密に送った順** |
| 重複 | 同じメッセージが 2 回以上届くことがある | 送る側の重複を 5 分間除く（重複排除 ID） |
| スループット | ほぼ無制限 | API ごとに 1 秒 300 回（バッチで 3,000 件）。高スループットモードで上がる（公式「Amazon SQS message quotas」） |
| メッセージグループ ID | 任意（付けると fair queue になる） | **必須**。無いと送信が失敗する |
| Lambda のバッチサイズの上限 | 10,000 | 10 |

「FIFO なら全体が 1 列に並ぶ」わけではない。**順序が守られるのは同じメッセージグループの中だけ**で、別のグループどうしは並行に、順不同で処理される（公式「FIFO queue delivery logic」）。

## 仕組み

### メッセージの一生

```text
送る側 ──SendMessage──▶ キュー ──ReceiveMessage──▶ 受け取る側
                          │                          │
                          │  見えない（可視性タイムアウト）  │ 処理する
                          │◀──────── DeleteMessage ──┘ 成功: 消す
                          │
                          └─ 消されないまま時間切れ → 再び見える → もう一度受信される
                             受信回数が maxReceiveCount を超えたら → DLQ へ移す
```

受信したメッセージは、キューから消えるのではなく、**可視性タイムアウト**の間だけ他の受け手から見えなくなる。その間に `DeleteMessage` で消されなければ、再び見えるようになり、もう一度受信される（公式「Amazon SQS visibility timeout」）。受け手が落ちてもメッセージが失われないのは、この仕組みのため。

| 設定 | 範囲（公式） | 既定 |
|---|---|---|
| 可視性タイムアウト | 0 秒〜12 時間 | 30 秒 |
| 保持期間 | 60 秒〜14 日 | 4 日 |
| メッセージの大きさ | 1 バイト〜1 MiB | — |
| 1 回のバッチ API に載せる件数 | 最大 10 件 | — |

保持期間を過ぎたメッセージは、処理されていなくても消える。

### メッセージグループと順序

FIFO では、送るときに**メッセージグループ ID** を必ず付ける。順序はグループごとに守られる（公式「FIFO queue delivery logic」）。

- 同じグループのメッセージは、送った順に受信される
- **同じグループのメッセージが受信されて処理中（可視性タイムアウトの間）だと、そのグループの後続は誰にも渡されない**。前のメッセージが消されるか、再び見えるようになるまで待つ
- 1 回の受信で、同じグループの複数のメッセージ（最大 10 件）がまとめて返ることはある。足りなければ別のグループのメッセージも混ざるが、それぞれのグループの中の順序は保たれる
- 受け手が特定のグループを指定して受信することはできない

つまり、**グループは「この中は 1 件ずつ順に」という単位であり、同時に「この中が詰まると後ろも止まる」という単位**でもある。グループを細かく分けるほど並行に処理でき、1 つにすると全体が 1 列になる。

### 重複排除

FIFO は、**送る側の重複**を除く（公式「Exactly-once processing」「Using the message deduplication ID」）。

- 同じ**重複排除 ID** のメッセージを 5 分以内に送ると、2 通目以降は**成功として受け付けられるが、受け手には渡されない**
- 重複排除 ID は、メッセージが受信・削除された後も、5 分の期間の間は覚えられている
- ID の決め方は 2 つ。送るときに明示する（`MessageDeduplicationId`）か、キューで**内容ベースの重複排除**を有効にし、本文の SHA-256 を ID にする（メッセージ属性は含まない）

送信が失敗したかどうか分からないとき（応答が返ってこなかったなど）に、**同じ ID で送り直せば重複しない**のが要点。ID を送るたびに新しく作る（UUID など）と、重複排除は効かない。

**除けるのは「キューに入る重複」だけで、「受け手が 2 回処理する」ことは防げない。** 受け手が処理した直後、消す前に落ちれば、メッセージは再び見えるようになり、もう一度処理される。

### DLQ（デッドレターキュー）

何度受信しても消されないメッセージを、別のキュー（DLQ）へ移して隔離できる（公式「Using dead-letter queues」）。

- 元のキューの **redrive policy** に、移す先の DLQ と `maxReceiveCount`（何回受信されたら移すか）を書く
- **FIFO キューの DLQ は FIFO キュー**でなければならない
- DLQ 側の **redrive allow policy** で、どのキューからの移動を受け付けるかを絞れる（`byQueue` で最大 10 個。既定はすべて許す）
- 移ったメッセージを元のキューへ戻す（redrive）こともできる

保持期間の数え方が、標準キューと FIFO で違う。

| | DLQ に移ったときの保持期間の起点 |
|---|---|
| 標準キュー | **元のキューに入った時刻のまま**。元で 1 日いたメッセージは、保持 4 日の DLQ では 3 日で消える。公式は DLQ の保持期間を元より長くするよう勧めている |
| FIFO キュー | **DLQ に移った時刻から数え直す**。保持 4 日の DLQ なら、移ってから 4 日残る |

公式は、操作の順序そのものに意味がある用途（例: 編集の手順）では、FIFO に DLQ を付けないよう注意している。**失敗したメッセージが DLQ へ抜けると、同じグループの後続はそれを飛ばして先へ進む**ため、グループの中の順序が崩れる。

### Lambda のイベントソースとして使ったとき

イベントソースマッピングの動き（ポーリング・同期の呼び出し・部分バッチ応答）は [Lambda 解説](lambda.md#sqs-をイベントソースにしたとき)にまとめた。ここでは FIFO に特有の点だけを書く（公式「Using Lambda with Amazon SQS」「Configuring scaling behavior」「Lambda parameters for Amazon SQS」）。

| 観点 | FIFO での動き |
|---|---|
| 並行数 | **アクティブなメッセージグループの数**と、最大同時実行数の設定の、小さいほうが上限になる。グループが 6 つなら、最大で 6 並行 |
| 失敗したとき | 関数がエラーを返したら、**そのメッセージの再試行がすべて終わるまで**、同じグループの次のメッセージを受け取らない |
| バッチサイズ | 最大 10（標準キューは 10,000） |
| バッチウィンドウ（`MaximumBatchingWindowInSeconds`） | **使えない** |
| 可視性タイムアウト | 関数のタイムアウトの **6 倍以上**を推奨。関数がスロットルされたときに、Lambda が呼び直す時間を残すため。関数のタイムアウトが可視性タイムアウトより長いと、マッピングの作成・更新がエラーになる |
| `maxReceiveCount` | **5 以上**を推奨。Lambda に何回か再試行の機会を残すため |

部分バッチ応答を FIFO で使うときの公式の指示は「**最初の失敗で処理をやめ、失敗したものと未処理のものをすべて返す**」（公式「Handling errors for an SQS event source」）。これより緩い形として、Powertools for AWS Lambda の `SqsFifoPartialProcessor` には `skipGroupOnError` という設定があり、**失敗したグループの残りだけを返し、別のグループは処理を続ける**（公式「Powertools for AWS Lambda (TypeScript): Batch processing」）。グループの中の順序だけが守られればよい場合の選択肢。

## このプロジェクトで使う理由

元資料の構成のうち、投入 Lambda と Consumer Lambda の間のメール送信キューを SQS FIFO で動かす（[元資料](../references/aws-batch-architecture.md#各サービスの役割)）。1 つの Lambda で大量のメールを送ると、15 分の上限・途中で失敗したときの進捗・送信先のレート制限が問題になる。キューを挟めば、1 通ずつ独立に処理・再試行でき、失敗し続けたものだけが DLQ に隔離される。FIFO を選んだ業務上の理由（順序が要る要件があるか）は、元資料でも「要確認」のまま。

| 使っているもの | このプロジェクトでの使い方 | 正本 |
|---|---|---|
| メッセージグループ ID | 配信対象の ID（`recipientId`）。順序が要るのは同じ宛先の中だけなので、宛先ごとに分け、別の宛先は並行に処理する | 05「[メールメッセージ](../05-data-specification.md#メールメッセージmailmessage)」 |
| 重複排除 ID | `<実行名>:<配信対象 ID>` で、投入 Lambda が決定的に作る。内容ベースの重複排除は使わない。同じ実行の再投入（Step Functions の `Retry`）を 5 分以内なら除く | 05「[メールメッセージ](../05-data-specification.md#メールメッセージmailmessage)」・03「[投入 Lambda](../03-functional-specification.md#投入-lambdaenqueue)」 |
| 送信 | `SendMessageBatch` で 10 件ずつ。一部が失敗したら、残りを送り切ってから投げ、`Retry` で全件を送り直す（重複排除 ID が同じなので、送れた分は重複しない） | 03「[投入 Lambda](../03-functional-specification.md#投入-lambdaenqueue)」 |
| 可視性タイムアウト | 60 秒（Consumer のタイムアウト 10 秒の 6 倍）。Consumer のタイムアウトの正本は Terraform の変数で、可視性タイムアウトはそこから計算し、CDK は SSM から読む | 04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」 |
| イベントソースマッピング | バッチサイズ 5、部分バッチ応答（`ReportBatchItemFailures`）を有効にする | 04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」・07「[Consumer Lambda の出力](../07-api-specification.md#consumer-lambda-の出力部分バッチ応答)」 |
| 失敗したメッセージの扱い | 失敗したメッセージと、**同じグループの後続**を失敗として返す。別のグループはそのまま送る | 03「[Consumer Lambda](../03-functional-specification.md#consumer-lambdaconsumer)」 |
| DLQ | 受信 3 回で移す（`maxReceiveCount: 3`）。DLQ への移動は、メール送信キューからだけ許す（redrive allow policy） | 04「[リトライ](../04-non-functional-specification.md#リトライ)」・09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」 |
| 保持期間 | キュー 1 日、DLQ 4 日 | 04「[保持期間](../04-non-functional-specification.md#保持期間)」 |
| 暗号化 | SQS 管理の鍵によるサーバー側暗号化（SSE-SQS） | 06「[データ保護](../06-security-specification.md#データ保護)」 |
| 管理 | キュー・DLQ は Terraform が作り、CDK は SSM の ARN から参照してイベントソースマッピングだけを作る | 09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」 |

## 特徴と制約

### Consumer の失敗は通知に乗らない

Step Functions は、投入 Lambda がキューに積んで正常に終わった時点で成功になる。Consumer は Step Functions の外で動くため、Consumer の失敗で DLQ にメッセージが移っても、実行は `SUCCEEDED` のままで、失敗の通知は出ない。元資料のリスク 1 を再現するため、意図的にそうしている（02「[F-5](../02-requirements-specification.md#f-5-失敗通知)」）。DLQ のアラームは将来構成（09「[将来構成](../09-architecture-specification.md#将来構成)」）。

### 重複排除が効く範囲

| 重複の起き方 | 防げるか |
|---|---|
| 同じ実行の投入が 5 分以内に `Retry` される | **防げる**。重複排除 ID が同じになる |
| 5 分を超えてから再投入される | 防げない。重複排除の期間を過ぎている |
| 別の実行として投入される（手動の再実行・同じ起動から実行が 2 つ始まる） | 防げない。実行名が違うので重複排除 ID も違う。同じ起動から実行が 2 つ始まりうるか（Scheduler がやり直しで同じ実行名を使うか）は未観測で、防がないと決めた（04「[リトライ](../04-non-functional-specification.md#リトライ)」・[EventBridge 解説](eventbridge.md#定時の起動の実行名を誰が付けているか)） |
| Consumer が送った直後、消す前に落ちる | 防げない。重複排除は送る側の話で、受け手の二重処理は対象外 |

最後の砦は Consumer 側の冪等化（送信済みかを確かめる）だが、このデモでは持たず、将来構成にしている（05「[メールメッセージ](../05-data-specification.md#メールメッセージmailmessage)」・元資料「[二重投入・二重送信](../references/aws-batch-architecture.md#2-二重投入二重送信)」）。

### 失敗し続けるメッセージは、同じ宛先の別の実行も止める

グループは配信対象ごとで、**実行をまたいで共有される**。`failAt: "consumer"` で失敗し続けるメッセージがグループの先頭にあると、DLQ へ移るまで（可視性タイムアウト 60 秒 × 受信 3 回で約 3 分）、同じ宛先の後から来たメッセージは渡されない（上記「メッセージグループと順序」）。05 はこの影響と、IT が `consumer` のケースを最後に回す理由を書いている（05「[メールメッセージ](../05-data-specification.md#メールメッセージmailmessage)」・08「[テストケース](../08-test-specification.md#テストケース)」）。

失敗したメッセージが DLQ へ移ると、同じグループの後続はそれを飛ばして先へ進む。このデモでは、同じ宛先のメールの順序は崩れうる（上記「DLQ」）。

### 部分バッチ応答は、公式の指示より緩い形

Consumer は失敗したグループの後続だけを返し、別のグループは処理を続ける。公式の指示（最初の失敗で全部やめる）より緩く、Powertools の `skipGroupOnError` と同じ形（上記）。グループは宛先ごとなので、影響は同じ宛先の中に閉じる。グループの後続まで返す理由（返さないと、再配信された前のメッセージより後続が先に送られ、順序が逆転する）は 03「[Consumer Lambda](../03-functional-specification.md#consumer-lambdaconsumer)」にある。

イベントそのものの形式が不正なときは、例外を投げてバッチ全体を再配信させる（03）。例外を投げると、部分バッチ応答を有効にしていてもバッチ全体の失敗になる（公式）。

### 受信回数と DLQ の保持期間は、公式の推奨と違う

| | 公式の推奨 | このプロジェクト | 理由の正本 |
|---|---|---|---|
| `maxReceiveCount` | 5 以上（Lambda のイベントソースのとき） | 3 | 04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」（DLQ に移るまでを約 3 分にして、失敗の結果を待てる時間で見る） |
| DLQ の保持期間 | 元のキューより長く（標準キューの場合の推奨） | DLQ 4 日 > キュー 1 日 | 04「[保持期間](../04-non-functional-specification.md#保持期間)」 |

DLQ を元より長くする推奨は、移った後も元の時刻から数える**標準キュー**のためのもの。FIFO は移った時刻から数え直す（上記）ので、DLQ を 1 日にしても、移ってから 1 日は残る。4 日にしているのは、DLQ の中身を後から見られるようにするためで、標準キューの理由とは別。

### 並行数は宛先の数で決まる

並行数はアクティブなグループの数が上限になる（上記）。配信対象は固定の 3 件で、グループも 3 つなので、Consumer は多くても 3 並行で動く。配信対象が 1 件なら、1 並行にしかならない。

### 料金

毎月 100 万リクエストまで無料（公式）。ペイロードは 64 KB ごとに 1 リクエストと数える。このデモの量（1 実行で数件の送信・受信・削除）は無料の範囲に収まる。FIFO と標準キューの単価は、料金ページから読み取れなかった（未確認）。

## LocalStack との違い

このプロジェクトで観測した、SQS の振る舞いの違いは無い。ただし、確かめた範囲が LocalStack と `dev` で違う。

| 確かめたこと | LocalStack（IT） | `dev` |
|---|---|---|
| 正常な実行で、メール送信スタブが配信対象の件数だけ動く | 確かめた | 確かめた（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」） |
| `failAt: "consumer"` で、DLQ に配信対象の件数のメッセージが届き、実行は `SUCCEEDED`・通知は出ない | 確かめた（08 #22） | **確かめていない** |
| `failAt: "enqueue"` で、キューにも DLQ にも積まれない | 確かめた（08 #25） | 確かめていない |

失敗したグループの後続を返す扱い（08 #24）は UT で確かめている。可視性タイムアウト・受信回数・グループのロックが実 AWS で同じように効くかは、`dev` では見ていない。

LocalStack のコンテナには前回の実行のメッセージが残るため、IT は開始時にキューと DLQ を空にする。残ったメッセージは FIFO の同じグループの今回のメッセージを止めるため（08「[テストケース](../08-test-specification.md#テストケース)」）。LocalStack 全体の性質は [LocalStack 解説](localstack.md#本物の-aws-との違い)を参照。

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| FIFO キューを作れない | 名前の末尾が `.fifo` でない。標準キューを FIFO に変えることもできないため、作り直す |
| 送信が失敗する | `MessageGroupId` が無い。FIFO では必須 |
| 送信が失敗する（重複排除 ID が無い） | 内容ベースの重複排除が無効なら、`MessageDeduplicationId` を必ず付ける |
| 送ったのに受け手に届かない | 5 分以内に同じ重複排除 ID で送っている。成功が返るので、送る側からは分からない |
| 再試行したのにメールが二重に送られる | 重複排除 ID を送るたびに作っている（UUID など）。業務のキーから決定的に作る |
| 1 件の失敗で、後ろのメッセージが全部止まる | 同じグループに並んでいる。グループの先頭が処理中・再試行中の間は、後続は渡されない。順序が要らない単位でグループを分ける |
| Consumer が 1 並行でしか動かない | グループが 1 つしかない。並行数はグループの数が上限 |
| 処理中のメッセージが二重に処理される | 可視性タイムアウトが関数のタイムアウトより短い（またはぎりぎり）。6 倍以上にする |
| イベントソースマッピングを作れない | 関数のタイムアウトが可視性タイムアウトより長い。Lambda が作成時に検証する |
| 部分バッチ応答を返しているのに、成功したメッセージまで再配信される | 関数が例外を投げている、または `itemIdentifier` が空・存在しない ID になっている。どちらもバッチ全体の失敗になる |
| FIFO でバッチウィンドウを設定できない | FIFO では使えない |
| DLQ に移ったメッセージが思ったより早く消える | 標準キューでは元のキューに入った時刻から数える。DLQ の保持期間を元より長くする |
| LocalStack の IT で、今回のメッセージがなかなか処理されない | 前回の失敗したメッセージが同じグループに残っている。開始時にキューを空にする |

## 参考資料

- [Amazon SQS FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fifo-queues.html)
- [FIFO queue delivery logic in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)（グループの順序・処理中の後続が渡されないこと）
- [Exactly-once processing in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html)・[Using the message deduplication ID](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html)
- [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Using dead-letter queues in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)（FIFO と標準の保持期間の違い）
- [Amazon SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)・[Amazon SQS FIFO queue quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-fifo.html)・[High throughput for FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html)
- [Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)・[Creating and configuring an Amazon SQS event source mapping](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)（6 倍・`maxReceiveCount` 5 以上）
- [Configuring scaling behavior for SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)（FIFO の並行数）・[Lambda parameters for Amazon SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-parameters.html)
- [Handling errors for an SQS event source in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)（FIFO の部分バッチ応答）
- [Powertools for AWS Lambda (TypeScript): Batch processing](https://docs.aws.amazon.com/powertools/typescript/latest/features/batch/)（`skipGroupOnError`）
- [Amazon SQS pricing](https://aws.amazon.com/sqs/pricing/)
