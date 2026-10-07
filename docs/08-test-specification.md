# テスト仕様書

テスト戦略・テストケース・ツールを定義する。詳細なテスト設計は、M3 の着手時に `/test-design` で `docs/test-design/` に作成する。

## 目次

- [テスト戦略](#テスト戦略)
- [テストケース](#テストケース)
- [カバレッジ目標](#カバレッジ目標)
- [テストツール・実行方法](#テストツール実行方法)
- [原則](#原則)

## テスト戦略

| レイヤー | ツール | 対象 |
|----------|--------|------|
| UT（handler） | Vitest | 各 handler の分岐・検証・エラーの契約。スタブはインターフェース経由で本物を注入し、AWS SDK の呼び出し（SQS・S3）だけをモックする |
| UT（スキーマ） | Vitest | Zod スキーマの受理・拒否の境界 |
| UT（CDK） | Vitest + `aws-cdk-lib/assertions` | 合成したテンプレートの要点（タイムアウトの連動・`Retry` の対象・`mutable: false`・イベントパターン） |
| IT | Vitest + LocalStack | `local` にデプロイした状態で実行を起動し、02 の受け入れ条件を自動で確かめる |
| 手動確認 | AWS CLI | `dev` でのみ確かめられる 2 点（Scheduler の定時起動・状態変化イベントによる通知） |

- **モックするのは外部 I/O だけ**（`testing.md`）。スタブは「外部サービスの代わり」だが、ビジネスロジックの一部ではないので UT でもそのまま使う。出力の確認はログの捕捉で行う
- AWS SDK のモックには `aws-sdk-client-mock` を使う
- IT の対象は「サービス間のつながり」に絞る。handler の分岐の網羅は UT で行う

## テストケース

代表ケース。網羅は `/test-design` で行う。

| # | ケース | レベル | 分類 |
|---|--------|--------|------|
| 1 | 投入: 配信対象 3 件をキューへ送り、`{ enqueued: 3 }` を返す | UT | 正常系 |
| 2 | 投入: 重複排除 ID が `<executionName>:<recipientId>`、グループ ID が `recipientId` になる | UT | 正常系 |
| 3 | 投入: `failAt: "consumer"` のとき全メッセージの `simulateFailure` が `true` | UT | 正常系 |
| 4 | 投入: `failAt: "enqueue"` のとき SQS を呼ばずに `InjectedFailureError` を投げる | UT | 準正常系 |
| 5 | 投入: `failAt` が未定義の値なら `ValidationError` を投げる | UT | 準正常系 |
| 6 | 投入: `executionName` に `/` を含むと `ValidationError` を投げる | UT | 準正常系 |
| 7 | 投入: 同じ入力で 2 回呼ぶと、2 回とも同じ重複排除 ID で送る（Retry 時の重複排除の前提） | UT | 準正常系 |
| 8 | 投入: `SendMessageBatch` の一部が失敗すると `EnqueuePartialFailureError` を投げる | UT | 異常系 |
| 9 | Consumer: 5 件すべて成功なら `batchItemFailures` が空 | UT | 正常系 |
| 10 | Consumer: `simulateFailure: true` の 1 件だけが `batchItemFailures` に入る | UT | 準正常系 |
| 11 | Consumer: JSON として読めない本文の 1 件だけが `batchItemFailures` に入り、他は送信される | UT | 準正常系 |
| 12 | データ連携: S3 に `exports/<日付>/<実行名>.json` を書き、BigQuery・Cuenote FC スタブへ出力する | UT | 正常系 |
| 13 | データ連携: `failAt: "dataSync"` のとき S3 には書き、BigQuery・Cuenote FC へは出力せずに失敗する | UT | 準正常系 |
| 14 | データ連携: S3 への書き込みが失敗するとエラーを投げ、後段へは出力しない | UT | 異常系 |
| 15 | 通知: `FAILED` のイベントで、実行名・状態・エラー名を Slack スタブへ出す | UT | 正常系 |
| 16 | 通知: `TIMED_OUT` で `error` / `cause` が `null` でも出力できる | UT | 準正常系 |
| 17 | 通知: 対象外の `detail-type` では何も出さず、エラーも投げない | UT | 準正常系 |
| 18 | CDK: SQS の可視性タイムアウトが Consumer のタイムアウトの 6 倍 | UT | 異常系（設定ずれの検出） |
| 19 | CDK: Lambda タスクの `Retry` に `InjectedFailureError` / `ValidationError` が含まれない | UT | 異常系（設定ずれの検出） |
| 20 | `failAt` なしの実行が `SUCCEEDED` になり、S3 にファイルができる | IT | 正常系 |
| 21 | `failAt: "dataSync"` の実行が `FAILED` になり、Slack スタブのログが出る | IT | 準正常系 |
| 22 | `failAt: "consumer"` の実行後、DLQ に 3 件届く | IT | 準正常系 |
| 23 | `dev` で Schedule が実行を起動し、`FAILED` で通知が出る | 手動 | 正常系 |

#18 は SQS が Terraform 側にあるため、CDK のテストからは Terraform の値を直接見られない。Terraform の変数ファイルから可視性タイムアウトを読み、CDK 側の Consumer のタイムアウトと比べる方式を実装時に決める。

## カバレッジ目標

- `functions/src/` の行カバレッジ 80% 以上を CI で強制する（下回ったら落とす）
- 数値より、上記の準正常系・異常系（失敗の注入・検証エラー・部分失敗）が全 handler で通っていることを重視する
- `infra/` はカバレッジの対象外。CDK は #18・#19 のような「ずれると壊れる設定」をテストで固定する

## テストツール・実行方法

コマンドの正本は実装時に `package.json` の scripts に置く。

| 対象 | 実行 | CI |
|---|---|---|
| UT（handler・スキーマ・CDK）と型検査 | `npm test` / `npm run typecheck` | PR で毎回実行する（必須チェック） |
| IT | LocalStack を起動して `npm run test:it` | 当面は手元のみ。LocalStack の起動時間と安定性を見て、CI へ載せるかを決める |
| 手動確認 | 03「操作方針」の手順 | 対象外 |

## 原則

テストの分類と原則（仕様の証明・正常系 1 : 異常系 2 以上・外部 I/O のみモック・曖昧なアサーションの禁止）は [`.claude/rules/testing.md`](../.claude/rules/testing.md) を正本とする。

テストを追加・変更したら、対象の実装をわざと壊して失敗することを一度確かめる（`quality-gate.md`「検査は壊して確かめる」）。
