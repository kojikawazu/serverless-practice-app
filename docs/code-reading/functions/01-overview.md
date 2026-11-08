# 概要・エントリポイント

## このコードは何をするか

元資料のバッチ構成のうち、処理の段を担う 4 つの Lambda 関数。配信対象をメール送信キュー（SQS FIFO）へ積み（投入）、キューから 1 件ずつメールを送り（Consumer）、配信対象を外部へ書き出し（データ連携）、失敗を Slack へ知らせる（Slack 通知）。外部サービス（MySQL・SendGrid・BigQuery・Cuenote FC・Slack）はすべてスタブで、実在の宛先へは何も送らず、構造化ログに出すだけにしている。

## エントリポイント

CDK が `functions/src/handlers/<name>.ts` の `handler` を各 Lambda の入口に指定している（`infra/cdk/lib/batch-stack.ts:430`）。

| 起点 | 場所 | 呼ぶもの・呼ばれ方 | 何を始めるか |
|---|---|---|---|
| 投入 `handler` | `functions/src/handlers/enqueue.ts:154` | Step Functions（同期） | 配信対象ごとのメールメッセージを SQS FIFO へ積む |
| Consumer `handler` | `functions/src/handlers/consumer.ts:108` | SQS のイベントソースマッピング | 受け取ったメッセージを 1 件ずつ SendGrid スタブへ送り、失敗したものだけを返す |
| データ連携 `handler` | `functions/src/handlers/data-sync.ts:257` | Step Functions（非同期 + `.waitForTaskToken`） | 配信対象を S3・BigQuery スタブ・Cuenote FC スタブへ書き、結果をタスクトークンで返す |
| Slack 通知 `handler` | `functions/src/handlers/notify-slack.ts:113` | EventBridge のルール（非同期） | 実行の失敗・アラームの `ALARM` を Slack スタブへ知らせる |

呼ばれ方の違い（誰がやり直すか）は [Lambda 解説](../../guides/lambda.md#このプロジェクトで使う理由)、各関数の仕様は 03「[処理仕様](../../03-functional-specification.md#処理仕様)」を参照。

## 全体像

4 つの handler は、どれも同じ 2 段の形をしている。

```text
handler(event)                    ← Lambda の入口。組み立て役
  ├─ loadHandlerContext(...)       環境変数を Zod で検証し、ロガーを作る
  ├─ 本物の依存を組み立てる          SDK クライアント（モジュールに 1 つ）・スタブ
  └─ 本体(event, deps) を呼ぶ
        本体(input: unknown, deps)  ← 処理の中身。テストはここに依存を直接渡す
          ├─ parseInput(schema, input)  入力を検証。不正なら ValidationError
          └─ 処理（deps 経由で SQS / S3 / Step Functions / スタブを呼ぶ）
```

- **入口（`handler`）と本体（`enqueue` / `consume` / `dataSync` / `notifySlack`）を分けている。** 本体は依存（`deps`）を引数で受け取るため、テストは AWS SDK だけを偽物（`aws-sdk-client-mock`）にし、スタブ・ロガー・時刻・待ちは本物か差し替えたものを渡す
- **入力はすべて `unknown` で受け、Zod で検証してから使う。** 呼び出し元が AWS のサービスでも形を信頼しない（06「[入力バリデーション](../../06-security-specification.md#入力バリデーション)」）。検証済みの値の型は、スキーマから `z.infer` で導出する
- **外部サービスは「口」（`types/` のインターフェース）を通して呼ぶ。** handler はスタブのクラスを入口で組み立てるだけで、本体は口の型しか知らない（09「[外部サービスのスタブ](../../09-architecture-specification.md#外部サービスのスタブ)」）
- **ログは 1 行 1 JSON。** 全行に `function` と `stage` が付き、実行名が分かった後は `executionName` も付く（04「[運用性](../../04-non-functional-specification.md#運用性)」）

各層の責務は [03](./03-modules.md)、Lambda ごとの流れは [02](./02-flow.md) を参照。
