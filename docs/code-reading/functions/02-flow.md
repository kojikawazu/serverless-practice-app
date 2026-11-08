# 処理フロー

4 つの Lambda について、処理の流れと呼び出し連鎖を示す。**失敗の返し方が Lambda ごとに違う**のが読みどころで、どれも呼ばれ方（同期・非同期・SQS）に合わせている。

| Lambda | 失敗の返し方 |
|---|---|
| 投入 | 例外を投げる。Step Functions の `Retry` がエラー名で判定する |
| Consumer | 失敗したメッセージだけを部分バッチ応答で返す。投げるのはイベント全体の形が不正なときだけ |
| データ連携 | **投げない。** `SendTaskFailure` で返す |
| Slack 通知 | 対象外のイベントは正常に終える。通知そのものの失敗だけを投げ直す |

## 投入（enqueue）

Step Functions から同期で呼ばれ、配信対象ごとのメールメッセージを SQS FIFO へ積む。

```mermaid
sequenceDiagram
    participant SF as Step Functions
    participant H as handler
    participant E as enqueue
    participant DB as MySqlStub
    participant Q as SQS FIFO
    SF->>H: タスク入力（executionName・failAt・holdSeconds）
    H->>H: loadHandlerContext（QUEUE_URL を検証）
    H->>E: enqueue(event, deps)
    E->>E: parseInput(taskInputSchema)
    alt failAt が enqueue
        E-->>SF: InjectedFailureError を投げる
    end
    E->>DB: findAll()
    DB-->>E: 配信対象 3 件
    loop 10 件ずつ
        E->>Q: SendMessageBatch（グループ ID は宛先、重複排除 ID は 実行名:宛先 ID）
        Q-->>E: Successful / Failed
    end
    alt Failed が 1 件以上
        E-->>SF: EnqueuePartialFailureError を投げる（Retry の対象）
    else
        E-->>SF: enqueued 件数を返す
    end
```

### ステップ詳細

1. `functions/src/handlers/enqueue.ts:155` — 環境変数（`STAGE`・`QUEUE_URL`）を検証し、ロガーを作る。不正なら `ValidationError` を投げる
2. `functions/src/handlers/enqueue.ts:76` — タスク入力を `taskInputSchema`（未知のキーを拒否）で検証する。検証に通ったら、以降のログに `executionName` を付ける（`:77`）
3. `functions/src/handlers/enqueue.ts:101` — `failAt` が `enqueue` なら、キューへ何も積まずに失敗する
4. `functions/src/handlers/enqueue.ts:106` — 配信対象ごとにメッセージを作る。`failAt` が `consumer` なら `simulateFailure: true` を本文に入れ、Consumer 側で失敗させる
5. `functions/src/handlers/enqueue.ts:125` — 10 件（`SendMessageBatch` の上限）ずつ送る。**一部が失敗しても残りのバッチは送り切り**、最後にまとめて `EnqueuePartialFailureError` を投げる（`:134`）
6. `functions/src/handlers/enqueue.ts:79` — どこで失敗しても、エラーログを 1 行出してから投げ直す

重複排除 ID が `<実行名>:<配信対象 ID>` で決まっているため、`Retry` で同じ実行が再投入されても、5 分以内なら FIFO が重複を除く（03「[投入 Lambda](../../03-functional-specification.md#投入-lambdaenqueue)」）。

## Consumer（consume）

SQS のイベントソースマッピングから、メッセージのバッチを受け取る。

```mermaid
sequenceDiagram
    participant Q as SQS FIFO
    participant H as handler
    participant C as consume
    participant M as SendGridStub
    Q->>H: SQS イベント（Records）
    H->>C: consume(event, deps)
    C->>C: parseInput(sqsEventSchema)
    loop Records を 1 件ずつ
        alt 同じグループの先行メッセージが失敗済み
            C->>C: 送らずに batchItemFailures へ
        else
            C->>C: JSON.parse と mailMessageSchema で本文を検証
            alt simulateFailure が true
                C->>C: InjectedFailureError を捕まえて batchItemFailures へ、グループを失敗済みにする
            else
                C->>M: send(mail)
            end
        end
    end
    C-->>Q: batchItemFailures（失敗したものだけが再配信される）
```

### ステップ詳細

1. `functions/src/handlers/consumer.ts:69` — イベント全体を検証する。ここで失敗したときだけ例外を投げ、バッチ全体が再配信される
2. `functions/src/handlers/consumer.ts:74` — レコードのメッセージグループ ID が、既に失敗したグループなら送らずに失敗として返す。送ると、再配信された前のメッセージが後から届き、グループ内の順序が逆転するため
3. `functions/src/handlers/consumer.ts:37` — 本文を `JSON.parse` してから `mailMessageSchema` で検証する。JSON として読めない（`SyntaxError`）・形が違う（`ValidationError`）・注入された失敗（`InjectedFailureError`）は、どれも `:86` で捕まえて、そのメッセージだけを失敗にする
4. `functions/src/handlers/consumer.ts:45` — 送信内容（`OutgoingMail`）に詰め替えて SendGrid スタブへ渡す。`simulateFailure` などキュー側の項目は渡さない

失敗したメッセージは受信 3 回で DLQ へ移り、Step Functions の実行の成否には影響しない（[SQS FIFO 解説](../../guides/sqs-fifo.md#consumer-の失敗は実行の成否に乗らない)）。

## データ連携（dataSync）

Step Functions から `.waitForTaskToken` で**非同期に**呼ばれる。戻り値も例外も Step Functions には届かないため、結果は必ずタスクトークンで返す。

```mermaid
sequenceDiagram
    participant SF as Step Functions
    participant H as handler
    participant D as dataSync
    participant S3 as S3
    participant W as BigQueryStub
    participant ML as CuenoteFcStub
    SF->>H: タスク入力（taskToken を含む）
    H->>D: dataSync(event, deps)
    D->>D: taskToken だけを先に取り出す
    alt taskToken が読めない
        D->>D: エラーログを出して終える（結果は返せない）
    end
    D->>D: parseInput(dataSyncTaskInputSchema)
    D->>S3: PutObject（exports/日付/実行名.json）
    alt failAt が dataSync
        D->>SF: SendTaskFailure（S3 の書き込みは残る）
    end
    D->>W: write
    D->>ML: write
    opt holdSeconds が 1 以上
        loop 60 秒ごと
            D->>SF: SendTaskHeartbeat
            D->>D: sleep
        end
    end
    D->>SF: SendTaskSuccess（exported・s3Key）
    Note over D,SF: どこで失敗しても捕まえて SendTaskFailure で返す。例外は投げない
```

### ステップ詳細

1. `functions/src/handlers/data-sync.ts:105` — `taskTokenHolderSchema`（`taskToken` だけを見るスキーマ）で、まず結果の返し先を取り出す。ほかの項目が不正でも、その失敗を返せるようにするため
2. `functions/src/handlers/data-sync.ts:110` — トークン自体が読めなければ結果を返せない。エラーログを出して正常に終え、ステートマシン側のハートビートのタイムアウトに任せる
3. `functions/src/handlers/data-sync.ts:151` — S3 のキーは `exports/<UTC の日付>/<実行名>.json`。同じ実行を再実行すると同じキーに上書きされる
4. `functions/src/handlers/data-sync.ts:162` — `failAt` が `dataSync` なら、**S3 へ書いた後・BigQuery へ書く前**に失敗する。前段の書き込みは残る（元資料のリスク 4。補償処理は持たない）
5. `functions/src/handlers/data-sync.ts:186` — `holdSeconds` の間、60 秒ごとにハートビートを送ってから待つ。LMI で 15 分を超える実行を再現するための注入（09「[15 分を超える実行の再現](../../09-architecture-specification.md#15-分を超える実行の再現)」）
6. `functions/src/handlers/data-sync.ts:126` — どこで失敗しても捕まえ、`reportFailure`（`:215`）で `SendTaskFailure` を送る。エラー名は Lambda が投げたときと同じ `error.name` にし、`Retry` の判定がそろうようにしている。`SendTaskFailure` 自体に失敗したら、ログを出すだけにする

**例外を投げない理由**: 非同期の呼び出しで投げた例外を受け取るのは Lambda の非同期の再試行だけで、同じタスクトークンで処理が二重に走る。そのため非同期の再試行は 0 にし、やり直しは Step Functions の `Retry` に任せている（[Lambda 解説](../../guides/lambda.md#失敗したときに誰がやり直すか)）。例外が出うるのは、`handler` が環境変数の検証に失敗したとき（`:258`）だけ。

## Slack 通知（notifySlack）

EventBridge のルールから非同期で呼ばれる。届くイベントは 2 種類で、`source` で見分ける。

```mermaid
sequenceDiagram
    participant EB as EventBridge ルール
    participant H as handler
    participant N as notifySlack
    participant SL as SlackStub
    EB->>H: 状態変化イベント
    H->>N: notifySlack(event, deps)
    N->>N: notificationEventSchema.safeParse
    alt 対象外（形が違う・SUCCEEDED・OK への変化など）
        N->>N: 警告ログを出して正常に終える
    else source が aws.states
        N->>SL: notify（実行名・ARN・状態・error・cause）
    else source が aws.cloudwatch
        N->>SL: notifyAlarm（アラーム名・理由）
    end
    Note over N,SL: 通知そのものの失敗はエラーログを出して投げ直し、Lambda の非同期の再試行に任せる
```

### ステップ詳細

1. `functions/src/handlers/notify-slack.ts:38` — `parseInput` ではなく `safeParse` を直接使う。対象外のイベントを `ValidationError` にせず、警告ログで済ませるため。投げても同じイベントを再試行で受け直すだけで、結果は変わらない
2. `functions/src/handlers/notify-slack.ts:46` — `source` で分ける。判別 union（`notificationEventSchema`）を通った後なので、分岐の中では型が絞り込まれている
3. `functions/src/handlers/notify-slack.ts:73` — `error` / `cause` は、項目が無い場合も `null` にそろえる。`TIMED_OUT` / `ABORTED` では値が無いことがある（07「[状態変化イベント](../../07-api-specification.md#状態変化イベントeventbridge--slack-通知-lambda)」）
4. `functions/src/handlers/notify-slack.ts:76` / `:101` — 通知の失敗はエラーログを出してから投げ直す
