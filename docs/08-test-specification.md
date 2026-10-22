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
| UT（handler） | Vitest | 各 handler の分岐・検証・エラーの契約。スタブはインターフェース経由で本物を注入し、AWS SDK の呼び出し（SQS・S3・Step Functions）だけをモックする |
| UT（スキーマ） | Vitest | Zod スキーマの受理・拒否の境界 |
| UT（CDK） | Vitest + `aws-cdk-lib/assertions` | 合成したテンプレートの要点（ステートマシンの種類・タイムアウトの受け取り方・`Retry` の対象・`mutable: false`・イベントパターン・`DataSync` の呼び出し方・LMI の紐付け） |
| UT（スクリプト） | Vitest + 偽の AWS CLI | `scripts/budget-alert.sh`。LocalStack が対応していない Budgets を、PATH の先頭の偽物（`test/scripts/helpers/fake-aws.ts`）で差し替えて確かめる。スクリプトは一時ディレクトリに複製し、手元の `.env` を読ませない。`scripts/batch.sh` の `run` も、終わらない・失敗する実行を思いどおりに作るため、Step Functions の偽物（`test/scripts/helpers/fake-aws-sfn.ts`）で確かめる。`scripts/check-doc-links.sh` は、一時ディレクトリに作った git のリポジトリに Markdown を置いて動かす（外部 I/O は無い。対象を git から引くところまで確かめる）。`scripts/cdk.sh` の `diff` は、差分の出方（置換の有無・方法による違い・失敗）を思いどおりに作るため、CDK の CLI を呼ぶ `npx` を偽物（`test/scripts/helpers/fake-npx-cdk.ts`）に差し替えて確かめる |
| 静的検査（Terraform） | `terraform fmt` / `validate`（`scripts/lint-terraform.sh`） | 整形・構文・参照・型・プロバイダのロック |
| IT | Vitest + LocalStack | `local` にデプロイした状態で実行を起動し、02 の受け入れ条件を自動で確かめる |
| 手動確認 | AWS CLI | `dev` でのみ確かめられる点（Scheduler の定時起動・状態変化イベントによる通知・LMI での実行）。結果は 09「`dev` での検証結果」 |

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
| 14 | データ連携: S3 への書き込みが失敗すると `SendTaskFailure` で失敗を返し、後段へは出力しない | UT | 異常系 |
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
| 25 | `failAt: "enqueue"` の実行が `FAILED` になり、Slack スタブのログに実行 ARN と `FAILED` が出て、キューにも DLQ にもメッセージが積まれない | IT | 準正常系 |
| 26 | `failAt` が未定義の値の実行が `ValidationError` で `FAILED` になり、Slack スタブのログが出る | IT | 準正常系 |
| 27 | 起動直後に止めた実行が `ABORTED` になり、Slack スタブのログに実行 ARN と `ABORTED` が出る（状態変化イベントが `FAILED` 以外でも rule に届くことの確認。09「LocalStack での検証結果」） | IT | 準正常系 |
| 28 | state バケットのスクリプト: 無いバケットを作って全項目をそろえ、2 回目の実行では何も変えず、`--check` が 0 で終わる | IT | 正常系 |
| 29 | state バケットのスクリプト: バージョニング・ライフサイクル（新しい版を残す条件だけ）・ポリシーを崩すと、`--check` が 1 でその 3 項目を示し、実行するとその 3 項目だけを直す | IT | 準正常系 |
| 30 | state バケットのスクリプト: 他のアカウントが持つ名前のバケットには何も設定せず、1 で終わる | IT | 異常系 |
| 31 | state バケットのスクリプト: 引数の誤りは 2 で終わる | IT | 準正常系 |
| 32 | 実行全体のタイムアウトを越えた実行が `TIMED_OUT` になり、Slack スタブのログに実行 ARN と `TIMED_OUT`、`null` の `error` / `cause` が出る（状態変化イベントの 3 つの状態がすべて rule に届くことの確認。09「LocalStack での検証結果」） | IT | 準正常系 |
| 33 | `dev` で定時の Schedule（`cron`）が実行を起動し、入力 `{}` の実行が `SUCCEEDED` になる（式の時・分だけを数分先へ一時的に変えて確かめる。09「`dev` での検証結果」） | 手動 | 正常系 |
| 34 | `dev` で実行全体のタイムアウトを越えた実行が `TIMED_OUT` になり、Slack スタブのログに実行 ARN と `TIMED_OUT` が出る。実行と通知の `error` / `cause` の値を記録する（#32 と同じ手順を AWS CLI で行う） | 手動 | 準正常系 |
| 35 | `holdSeconds: 61` の実行が、データ連携 Lambda の待ちの後に `SUCCEEDED` になり、実行時間が 61 秒以上で、S3 にファイルが 1 つできる（非同期の呼び出し・ハートビート・`SendTaskSuccess` の流れの確認） | IT | 正常系 |
| 36 | `dev` でデータ連携 Lambda が LMI で動く。インスタンスの台数・タイプ・パブリック IP、`holdSeconds: 960` で 15 分を超えて `SUCCEEDED`、`failAt: "dataSync"` で `FAILED` と通知、削除後にインスタンス・プロバイダ・VPC が残らないこと。インスタンスは `describe-instances --include-managed-resources` で数える（既定では見えない）（09「LMI」の「テスト」。結果は 09「`dev` での検証結果」。#66） | 手動 | 正常系 |
| 37 | データ連携: `holdSeconds` があれば、書き出しの後に 60 秒ごとにハートビートを送りながら待ってから `SendTaskSuccess` を返す。0 なら待たずハートビートも送らない。上限の 1,200 秒は受け付ける | UT | 正常系 |
| 38 | データ連携: タスクトークンが読めれば、入力の不正・注入エラーを `SendTaskFailure` で返し（`error` はエラー名、`cause` は `errorType` / `errorMessage` の JSON）、例外を投げない | UT | 準正常系 |
| 39 | データ連携: `SendTaskSuccess`・ハートビートが失敗したら `SendTaskFailure` で返し、`SendTaskFailure` も失敗したらエラーログを出して終える。`cause` のメッセージは 4,096 文字で切り詰める | UT | 異常系 |
| 40 | スキーマ: `holdSeconds` は 0〜1,200 の整数だけを受理する（1,201・-1・1.5・文字列・`null` を拒否）。`taskToken` はデータ連携のタスク入力だけが受け付ける | UT | 準正常系 |
| 41 | CDK: `DataSync` は `.waitForTaskToken` と `InvocationType: "Event"` で呼び、タイムアウト（関数 + 60 秒）とハートビート（300 秒）を持つ。データ連携 Lambda は非同期の呼び出しを再試行しない | UT | 異常系（設定ずれの検出） |
| 42 | CDK: `dev` ではデータ連携 Lambda だけを SSM のキャパシティプロバイダに紐付け（実行環境は最小・最大 1、タイムアウト 1,800 秒）、`local` ではどの関数も紐付けない | UT | 異常系（設定ずれの検出） |
| 43 | 予算アラートのスクリプト: 無ければ日次 1 USD の予算と実績 100% 超の通知を作り、2 回目は何も変えず、`--check` が 0 で終わる。通知先は環境変数か、`.env` の 1 行（`.env` を source しない） | UT | 正常系 |
| 44 | 予算アラートのスクリプト: 額（#72 より前の 3 USD を含む）・通知先・余分な通知のずれだけを直す。`ThresholdType` が `ABSOLUTE_VALUE` の通知は、省かれた `PERCENTAGE` とは別の通知として消す（#69）。通知の一覧が `NotFoundException` でも、予算があれば通知 0 件として扱う | UT | 準正常系 |
| 45 | 予算アラートのスクリプト: `--check` のずれ・確認での中止・同名で期間の違う予算は、何も変えずに 1 で終わる。引数・通知先の誤りは AWS を呼ばずに 2 で終わる。画面のメールアドレスは伏せる | UT | 準正常系 |
| 46 | 予算アラートのスクリプト: 読めない（権限不足）・作成の失敗・反映されない（API は成功）は 1 で終わる。読めないことを「無い」とみなして作らない | UT | 異常系 |
| 47 | 実行のスクリプト（`batch.sh run`）: `failAt` と `--hold-seconds`（順不同）を入力に入れ、`holdSeconds` は数値で渡す。待つ上限は 360 秒 + `holdSeconds`。`FAILED` でも終われば 0 で終わり、`cause` はメッセージだけを出す | UT | 正常系 |
| 48 | 実行のスクリプト: 範囲外・小数・数値でない `holdSeconds` は検証させるためにそのまま渡し、待つ上限を延ばさない。`BATCH_WAIT_SECONDS` が既定より優先される。値の無いオプション・未知のオプション・2 つ目の `failAt` は起動せずに 2 で終わる | UT | 準正常系 |
| 49 | 実行のスクリプト: 待つ上限を過ぎても `RUNNING` なら 1 で終わる。ステートマシンの一覧を取れない（認証切れ）・見つからないは、それぞれ別のメッセージで起動せずに 1 で終わる | UT | 異常系 |
| 50 | `dev` で、キャパシティプロバイダのロググループを Terraform が作り（保持 7 日）、LMI がそこへ書く。`down` で消え、10 分以上待っても LMI に作り直されない。作成・作り直しは CloudTrail の `CreateLogGroup` で数え、同じ検索で LMI の自動作成（10/15）が見えることを先に確かめる（09「`dev` での検証結果」の「LMI」。#71） | 手動 | 正常系 |
| 51 | リンクの検査（`check-doc-links.sh`）: 相対リンクのリンク先（ファイル・ディレクトリ）と見出しが実在すれば 0 で終わる。見出しの ID は GitHub と同じ規則（日本語・全角の括弧・バッククォート・`→`・同名の見出しの `-1`・パーセントエンコード）。同じファイルの中の見出しも確かめる。外部 URL と、コードスパン・コードフェンスの中のリンクは確かめない | UT | 正常系 |
| 52 | リンクの検査: リンク先のファイルが無い・見出しが 1 文字違う・同じファイルの見出しが無い・コードフェンスの中の `#`・同名の見出しの無い番号は、ファイルと行を出して 1 で終わる。未追跡のファイルも確かめ、`.gitignore` で除いたファイルは確かめない | UT | 準正常系 |
| 53 | リンクの検査: 検査する Markdown が 0 件・git のリポジトリの外は、0 件として通さずに 1 で終わる。追跡したまま手元で消したファイルは読まずに飛ばす | UT | 異常系 |
| 54 | データ連携 Lambda が結果もハートビートも返さない実行が、`DataSync` の `States.Timeout` で `FAILED` になる。実行の `error`・実行履歴の `TaskTimedOut` イベントの `error`・Slack スタブのログの `error` がどれも `States.Timeout`（`States.HeartbeatTimeout` ではない。09「LocalStack での検証結果」） | IT | 異常系 |
| 55 | CDK: ステートマシンの種類を `STANDARD` と明示する。Lambda タスクが一時的なエラーとして `Retry` するのは 04「リトライ」の 4 つだけで、`Lambda.ClientExecutionTimeoutException` を含めない（公式の推奨との違いを黙って戻させない） | UT | 異常系（設定ずれの検出） |
| 56 | CDK: Schedule の `RetryPolicy` を、最大 185 回・24 時間（`dev` で観測したサービスの既定と同じ値）と明示する（04「リトライ」） | UT | 異常系（設定ずれの検出） |
| 57 | CDK のスクリプト（`cdk.sh diff`）: `local` は `cdklocal` で `--method=change-set` と `--method=template` の両方を、`dev` は `cdk` で `--method=change-set` だけを、どちらも `--no-color` を付けて呼ぶ。置換を伴わない差分なら件数を出して 0 で終わる。`diff` 以外のコマンドは、引数をそのまま渡す | UT | 正常系 |
| 58 | CDK のスクリプト: 置換の印（`(requires replacement)` か、リソースの行の末尾の `replace`）がどちらかの方法の出力にあれば、作り直しを案内して 3 で終わる。`local` で変更セットだけ差分 0 件なら、見落としの可能性を警告する。後ろの引数は両方の呼び出しに渡す。未知のコマンドは 2 で終わる | UT | 準正常系 |
| 59 | CDK のスクリプト: `cdk diff` が失敗したら（変更セットの失敗ならテンプレートの比較に進まず）1 で終わる。差分のあるスタックの数を出力から読めなければ、終了コード 0 でも 1 で終わる | UT | 異常系 |
| 60 | CDK: Schedule の `DeadLetterConfig` を Terraform の DLQ（SSM の `scheduler-dlq/arn`）に向ける。DLQ のアラームは、`NumberOfMessagesSent` の 5 分間の合計が 1 以上で `ALARM` にし、データの無い期間は `ALARM` にしない。rule は、このアラームの `ALARM` への変化だけを Slack 通知 Lambda へ流す（#101） | UT | 正常系 |
| 61 | CDK: DLQ のアラームは、メッセージ数（`ApproximateNumberOfMessagesVisible`）ではなく送信数（`NumberOfMessagesSent`）で数える。メッセージ数で数えると、DLQ を空にするまで `ALARM` のままになり、次の失敗を通知しない（04「リトライ」） | UT | 異常系（設定ずれの検出） |
| 62 | 通知 Lambda: アラームの状態変化イベント（`ALARM`）で、アラーム名と理由を Slack スタブへ出す。イベントは `dev` で観測した実物を写した（07「アラームの状態変化イベント」） | UT | 正常系 |
| 63 | 通知 Lambda: アラームの `OK` / `INSUFFICIENT_DATA` への変化と、設定の変化（`CloudWatch Alarm Configuration Change`）は通知せず、警告ログを出して正常に終える | UT | 準正常系 |
| 64 | 通知 Lambda: アラーム名が空・理由の無いアラームのイベントは受理しない。アラームの通知先が失敗したら、アラーム名付きのエラーログを出してから投げ直す | UT | 異常系 |
| 65 | `local` で、Scheduler の DLQ へ 1 件送ると `NumberOfMessagesSent` のデータが出て、アラームが約 5 分後に `ALARM` になり、さらに約 11 分後に `OK` に戻る。LocalStack はこの状態変化を EventBridge に出さない。同じ形のイベントを `put-events` で入れると、rule を経て Slack スタブのログが出る（09「LocalStack での検証結果」。#101） | 手動 | 正常系 |
| 66 | `dev` で、Schedule のターゲットを存在しないステートマシンへ一時的に向けると、呼び出しが DLQ に届き、アラームが `ALARM` になり、Slack スタブのログにアラーム名が出る。DLQ のメッセージの属性（`ERROR_CODE`・`EXHAUSTED_RETRY_CONDITION`）と、届いたイベントの形を記録する（#101。結果は 09「`dev` での検証結果」） | 手動 | 異常系 |

IT（`test/it/batch.test.ts`）は 02 の受け入れ条件のうち `local` で確かめられるものを扱う。

- **確認はすべて実行名で絞り込む。** LocalStack には前回の実行のログ・ファイルが残るため。キューと DLQ だけは、残ったメッセージが FIFO の同じグループの今回のメッセージを止めるため、開始時に空にする
- **キューに積まれないこと（#25）は、そのケースの間だけ Consumer のイベントソースマッピングを無効にして、キューを直接受信して確かめる。** Consumer が動いていると、積まれたメッセージは数秒で受け取られて消えるため、壊れていても空に見える。途中で止まった IT が Consumer を止めたまま残しても、次の IT の開始時に有効へ戻す
- **`TIMED_OUT`（#32）は、その実行の間だけステートマシンの定義を書き換えて起こす。** 先頭に 10 秒の Wait ステートを足し、実行全体のタイムアウトを 2 秒にする。本番のタイムアウト（40 分）を待たずに済み、Lambda も呼ばれない。ARN は変わらないため、本番と同じ rule を通る。CDK のテンプレートは変わらないため再デプロイでは戻らず、途中で止まった IT が書き換えたまま残したら、次の IT の開始時に戻す（元のタイムアウトは書き換えた定義の Wait ステートに残す）。`error` / `cause` が `null` であることも確かめる。実 AWS でも値が無いことを手動で確かめた（#34）ため、LocalStack と同じ期待値でよい
- **ハートビート切れ（#54）も、その実行の間だけ定義を書き換えて起こす。** `DataSync` の `HeartbeatSeconds` を 2 秒にし、`holdSeconds: 10` で実行する。関数は待ちの始めに 1 回だけハートビートを送るため、本番のハートビート（300 秒）を待たずに、結果を返す前に切れる。元のハートビートは書き換えた `DataSync` の `Comment` に残し、途中で止まった IT が書き換えたまま残したら、次の IT の開始時に戻す。期待するエラー名 `States.Timeout` は LocalStack で観測した値で、**実 AWS の値は未観測**（09「LocalStack での検証結果」）。実 AWS で違う値だった場合は、この期待値を `local` 専用として扱う
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
| UT（handler・スキーマ・CDK）と型検査・Lint・整形 | `npm test` / `npm run typecheck` / `npm run lint` / `npm run format:check` | PR で毎回実行し、マージの必須チェックにする（`ci.yml` の `check`。09「CI とマージの条件」）。ドキュメント・ルールだけの変更ではスキップする |
| IT | `./scripts/localstack.sh up` → `./scripts/stack.sh local up` の後に `npm run test:it`（約 6 分。#22 で DLQ へ移るまで待つため・#35 で 61 秒待つため） | PR で毎回実行する（`ci.yml` の `it`。約 12 分の見込み。内訳は起動 1 分・デプロイ 2 分・IT 6 分（手元で計測）・削除 2 分）。マージの必須チェックにする。ドキュメント・ルールだけの変更ではスキップする。認証トークンはリポジトリのシークレット `LOCALSTACK_AUTH_TOKEN` から渡すため、トークンの渡らない fork からの PR では落ちる。Dependabot の PR には Dependabot 用のシークレットから渡る（09「LocalStack の認証」） |
| 手動確認 | 03「操作方針」の手順 | 対象外 |

## 原則

テストの分類と原則（仕様の証明・正常系 1 : 異常系 2 以上・外部 I/O のみモック・曖昧なアサーションの禁止）は [`.claude/rules/testing.md`](../.claude/rules/testing.md) を正本とする。

テストを追加・変更したら、対象の実装をわざと壊して失敗することを一度確かめる（`quality-gate.md`「検査は壊して確かめる」）。
