# セキュリティ仕様書

認証・認可・入力バリデーション・データ保護方針を定義する。共通の方針は [`.claude/rules/security.md`](../.claude/rules/security.md) を正本とし、本書ではこのデモでの適用を書く。

## 目次

- [認証](#認証)
- [認可（権限制御）](#認可権限制御)
- [入力バリデーション](#入力バリデーション)
- [データ保護](#データ保護)
- [脆弱性対策](#脆弱性対策)

## 認証

利用者向けの認証は持たない。画面・HTTP API が無く、外部から到達できる入口が無いため。

| 主体 | 認証 |
|---|---|
| 開発者（`dev` へのデプロイ・実行） | AWS CLI のプロファイル（手元の認証情報）。CI からのデプロイはしない（09「ステージ」） |
| 開発者（`local`） | AWS API にはダミー認証情報。LocalStack の起動には LocalStack アカウントの認証トークン（`LOCALSTACK_AUTH_TOKEN`。下記「データ保護」） |
| AWS サービス間 | IAM ロール（下記） |

外部サービスはすべてスタブのため、外部サービスの API キーは扱わない。扱う秘匿値は LocalStack の認証トークンだけ。

## 認可（権限制御）

IAM ロールは Terraform が作り、CDK は `mutable: false` で参照する（09「IaC の責務分担」）。CDK の `grant*` がポリシーを足せないため、**必要な権限はすべて Terraform 側で明示する**。

リソースの ARN は命名規約 `serverless-practice-app-<stage>-<name>`（10「命名」）で固定し、まだ存在しない CDK 側のリソースは接頭辞のワイルドカードで指定する。

| ロール | 引き受ける主体 | 許可する操作 | 対象 |
|---|---|---|---|
| 投入 Lambda | Lambda | `sqs:SendMessage` | メール送信キュー |
| Consumer Lambda | Lambda | `sqs:ReceiveMessage` / `sqs:DeleteMessage` / `sqs:GetQueueAttributes` | メール送信キュー |
| データ連携 Lambda | Lambda | `s3:PutObject` / `states:SendTaskSuccess` / `states:SendTaskFailure` / `states:SendTaskHeartbeat` | 出力先バケットの `exports/*` / ステートマシン `serverless-practice-app-<stage>-batch`（タスクトークンで結果を返すため） |
| Slack 通知 Lambda | Lambda | なし（ログ出力のみ） | — |
| ステートマシン | Step Functions | `lambda:InvokeFunction` | `serverless-practice-app-<stage>-enqueue` / `-data-sync`（`:*` のバージョン・エイリアスを含む） |
| Scheduler | EventBridge Scheduler | `states:StartExecution` / `sqs:SendMessage` | `serverless-practice-app-<stage>-batch` / Scheduler の DLQ（起動に失敗した呼び出しを送る。04「リトライ」） |
| LMI のオペレーター（`dev` だけ） | Lambda | AWS 管理ポリシー `AWSLambdaManagedEC2ResourceOperator` | キャパシティプロバイダが EC2 インスタンスを起動・終了する（公式の手順どおり。09「LMI（Lambda Managed Instances）」） |

- Lambda 4 種は共通で CloudWatch Logs への書き込み（`logs:CreateLogStream` / `logs:PutLogEvents`）を持つ。対象は自分のロググループに限る
- ロググループは CDK が作るため、`logs:CreateLogGroup` は付けない
- EventBridge rule から Slack 通知 Lambda への呼び出しは、関数側のリソースベースポリシーで許可する（CDK がターゲット設定時に付ける。ロールの変更ではない）。rule は 2 つ（実行の失敗・Scheduler の DLQ のアラーム）で、許可も rule ごとに 1 つずつ付く
- `*` のアクション・`*` のリソースは使わない。例外は LMI のオペレーターの AWS 管理ポリシーで、Lambda が EC2 を操作するために公式が指定するもの。`dev` で検証する間だけ存在する
- LMI のインスタンスのセキュリティグループは、受信を許さず、送信は HTTPS（443）だけにする
- **`local` では権限の過不足を確かめられない**: LocalStack は既定で IAM のポリシーを評価しないため、権限が足りなくても動く。最小権限で動くことは `dev` で確かめる（#23）

## 入力バリデーション

すべての handler は、受け取った入力を `unknown` として Zod で検証してから使う（`typescript.md`）。呼び出し元が AWS サービスであっても、形式を信頼しない。

| 入力 | ルール | 不正なときの振る舞い |
|-----------|--------|------|
| 実行入力 `failAt` | 省略、または `enqueue` / `dataSync` / `consumer` のいずれか | `ValidationError` で失敗する（リトライしない） |
| 実行入力 `holdSeconds` | 省略、または 0〜1,200 の整数 | `ValidationError` で失敗する（リトライしない） |
| 投入・データ連携 Lambda の `executionName` | 空でない文字列。80 文字以内、英数字・`-`・`_` のみ | `ValidationError` で失敗する |
| データ連携 Lambda の `taskToken` | 1〜2,048 文字の文字列（`SendTask*` の制約） | 結果を返せないため、エラーログを出して終える。`DataSync` はハートビートのタイムアウトで失敗する。投入 Lambda のタスク入力では未知のキーとして拒否する |
| SQS メッセージ本文 | JSON として読め、05「メールメッセージ」の全フィールドを持つ。`email` はメールアドレス形式 | その 1 件を失敗として返す（3 回で DLQ） |
| EventBridge イベント | `detail-type` が `Step Functions Execution Status Change`、`detail.status` が通知対象の 3 状態のいずれか | 警告ログを出して正常終了する |

`executionName` は S3 のキーと SQS の重複排除 ID に入るため、文字を制限してキーの区切り（`/`）を含ませない。

## データ保護

| 対象 | 方針 |
|---|---|
| 個人情報 | 扱わない。配信対象は `@example.com` の架空データのみ。ログに出してよい |
| 秘匿値 | `LOCALSTACK_AUTH_TOKEN` のみ。手元の `.env`（Git 管理外）に置き、変数名だけを `.env.example` で共有する。CI ではリポジトリのシークレットから `it` ジョブの LocalStack を起動するステップにだけ渡す（08）。シークレットは Actions 用と Dependabot 用の 2 か所に同じ値を置く（09「LocalStack の認証」）。fork からの PR には渡らない（09「CI とマージの条件」）。ほかに持つことになったら `dev` は Secrets Manager、手元は `.env` に置く（`security.md`） |
| S3 バケット | パブリックアクセスを全面ブロック。SSE-S3 で暗号化。バケットポリシーで HTTPS 以外のアクセスを拒否（`aws:SecureTransport`） |
| SQS キュー・DLQ | SQS 管理の鍵で暗号化（SSE-SQS） |
| 予算アラートの通知先 | メールアドレス（個人情報）は `.env`（Git 管理外）の `BUDGET_ALERT_EMAIL` にだけ置き、`.env.example` には変数名だけを置く。スクリプトはその 1 行だけを読み（`.env` を source しない）、画面には先頭の 1 文字とドメインだけを出す（09「予算アラート」） |
| Terraform の state | 09「Terraform の state」と `iac.md` に従う。秘匿値を含まないが、バケットはバージョニング有効・公開禁止 |

## 脆弱性対策

外部から到達できる入口が無いため、XSS・CSRF・CORS は対象外。SQL も発行しない（MySQL はスタブ）。

- **インジェクション**: 入力値を S3 のキー・重複排除 ID に埋め込むため、`executionName` を文字種で制限する（上記「入力バリデーション」）
- **依存パッケージ**: npm の依存は `package-lock.json` で固定し、npm と GitHub Actions の更新を Dependabot で追う（`.github/dependabot.yml`）。公開から 7 日待ってから提案させ、公開直後に取り下げられる版を避ける（セキュリティ更新は待たない）。Terraform provider・LocalStack のイメージ・`run:` 内のバージョンは対象外で、手で更新する
- **秘匿ファイルの混入**: `scripts/check-secret-files.sh` を CI で常時実行する（`static-analysis.md`）
- **秘密情報の push**: GitHub の Secret scanning と push protection を有効にしている。トークンの形をした文字列を含む push は GitHub が拒否し、既に入ったものはアラートになる。ファイル名で見る上の検査と、中身の形で見るこちらを重ねる
- **main の保護**: GitHub の ruleset で、PR を通さない変更・force push・削除を禁止し、CI の必須チェックが通らない PR をマージできなくしている（09「CI とマージの条件」）
- **GitHub Actions**: `permissions` を最小に絞り、actionlint で検査する（`github-actions.md`）
