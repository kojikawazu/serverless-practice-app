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
| UT（CDK） | Vitest + `aws-cdk-lib/assertions` | 合成したテンプレートの要点（タイムアウトの受け取り方・`Retry` の対象・`mutable: false`・イベントパターン） |
| 静的検査（Terraform） | `terraform fmt` / `validate`（`scripts/lint-terraform.sh`） | 整形・構文・参照・型・プロバイダのロック |
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
| 18 | CDK: Consumer のタイムアウトを SSM（`consumer/timeout-seconds`）から取り、値を直書きしていない | UT | 異常系（設定ずれの検出） |
| 19 | CDK: Lambda タスクの `Retry` に `InjectedFailureError` / `ValidationError` が含まれない | UT | 異常系（設定ずれの検出） |
| 20 | `failAt` なしの実行が `SUCCEEDED` になり、配信対象の件数のメール送信・S3 のファイル・BigQuery / Cuenote FC への出力がそろう | IT | 正常系 |
| 21 | `failAt: "dataSync"` の実行が `FAILED` になり、S3 にファイルが残り、BigQuery / Cuenote FC へは出力されず、Slack スタブのログが出る | IT | 準正常系 |
| 22 | `failAt: "consumer"` の実行が `SUCCEEDED` のまま、DLQ に配信対象の件数のメッセージが届き、Slack スタブのログは出ない | IT | 準正常系 |
| 23 | `dev` で Schedule が実行を起動し、`FAILED` で通知が出る | 手動 | 正常系 |
| 24 | Consumer: 失敗したメッセージと同じグループの後続は送らずに失敗として返し、別グループは送る | UT | 準正常系 |
| 25 | `failAt: "enqueue"` の実行が `FAILED` になり、Slack スタブのログに実行 ARN と `FAILED` が出て、メールは送られない | IT | 準正常系 |
| 26 | `failAt` が未定義の値の実行が `ValidationError` で `FAILED` になり、Slack スタブのログが出る | IT | 準正常系 |
| 27 | 起動直後に止めた実行が `ABORTED` になり、Slack スタブのログに実行 ARN と `ABORTED` が出る（状態変化イベントが `FAILED` 以外でも rule に届くことの確認。09「LocalStack での検証結果」） | IT | 準正常系 |
| 28 | state バケットのスクリプト: 無いバケットを作って全項目をそろえ、2 回目の実行では何も変えず、`--check` が 0 で終わる | IT | 正常系 |
| 29 | state バケットのスクリプト: バージョニング・ライフサイクル（新しい版を残す条件だけ）・ポリシーを崩すと、`--check` が 1 でその 3 項目を示し、実行するとその 3 項目だけを直す | IT | 準正常系 |
| 30 | state バケットのスクリプト: 他のアカウントが持つ名前のバケットには何も設定せず、1 で終わる | IT | 異常系 |
| 31 | state バケットのスクリプト: 引数の誤りは 2 で終わる | IT | 準正常系 |

IT（`test/it/batch.test.ts`）は 02 の受け入れ条件のうち `local` で確かめられるものを扱う。

- **確認はすべて実行名で絞り込む。** LocalStack には前回の実行のログ・ファイルが残るため。キューと DLQ だけは、残ったメッセージが FIFO の同じグループの今回のメッセージを止めるため、開始時に空にする
- **ケースは順番に実行し、`consumer`（#22）を最後に置く。** グループは配信対象ごとで実行をまたいで共有されるため、失敗し続けるメッセージが他のケースのメッセージを巻き込む（05「メールメッセージ」）
- **「出ない」ことは、先に出るはずのログ（Slack スタブ等）を確認してから一定時間待って確かめる。** すぐに見て 0 件だと、処理がまだ届いていないだけでも通ってしまう
- 前提（LocalStack の起動・デプロイ）が無ければ、スキップではなく失敗で終える

#18 は、可視性タイムアウトと Consumer のタイムアウトのずれを「検査で見つける」のではなく「ずれない構造にする」方針（04「連動するパラメータ」）に合わせ、CDK が値を自分で持たずに SSM から取っていることを固定する。Terraform 側の 6 倍の計算は `scripts/lint-terraform.sh` の検査対象のコードにあり、変数の検証（`validation`）で上限を守る。

## カバレッジ目標

- `functions/src/` の行カバレッジ 80% 以上を CI で強制する（下回ったら落とす）
- 数値より、上記の準正常系・異常系（失敗の注入・検証エラー・部分失敗）が全 handler で通っていることを重視する
- `infra/` はカバレッジの対象外。CDK は #18・#19 のような「ずれると壊れる設定」をテストで固定する
- 閾値が実装に対して効くことは、テストの無い関数を `functions/src/` に置いて失敗すること（行 70% で閾値割れ）で確かめた（#9）

Lint 設定そのものも検査の対象にする。`test/lint/jsdoc.test.ts` は、JSDoc 必須ルールの検出結果を fixture の印と突き合わせ、プラグインやセレクタの更新で検出が黙って変わったら落とす（`jsdoc.md`「検出結果を回帰テストに固定する」）。fixture には対象の構文ごとに「JSDoc 無し」と「JSDoc 付き」の両方を置く。片方だけでは、常に報告するセレクタを見逃す（#9 で `export const` について実際に起きた）。

## テストツール・実行方法

コマンドの正本は `package.json` の scripts。手元と CI（`.github/workflows/ci.yml`）が同じスクリプトを呼ぶ。

| 対象 | 実行 | CI |
|---|---|---|
| UT（handler・スキーマ・CDK）と型検査・Lint・整形 | `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` | PR で毎回実行する。ドキュメント・ルールだけの変更ではスキップする |
| IT | `./scripts/localstack.sh up` → `./scripts/stack.sh local up` の後に `npm run test:it`（約 4 分。#22 で DLQ へ移るまで待つため） | PR で毎回実行する（`ci.yml` の `it`。約 10 分。内訳は起動 1 分・デプロイ 2 分・IT 4 分・削除 2 分）。ドキュメント・ルールだけの変更ではスキップする。認証トークンはリポジトリのシークレット `LOCALSTACK_AUTH_TOKEN` から渡す |
| 手動確認 | 03「操作方針」の手順 | 対象外 |

## 原則

テストの分類と原則（仕様の証明・正常系 1 : 異常系 2 以上・外部 I/O のみモック・曖昧なアサーションの禁止）は [`.claude/rules/testing.md`](../.claude/rules/testing.md) を正本とする。

テストを追加・変更したら、対象の実装をわざと壊して失敗することを一度確かめる（`quality-gate.md`「検査は壊して確かめる」）。
