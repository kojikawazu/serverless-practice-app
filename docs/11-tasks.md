# タスク・進捗

開発タスク・マイルストーン・進捗を管理する。作業単位の進捗は GitHub issue を正本とし（`github-issue.md`）、本書には全体の順序と区切りだけを書く。

## 目次

- [マイルストーン](#マイルストーン)
- [タスク一覧](#タスク一覧)
- [完了済み（実績）](#完了済み実績)
- [将来課題・ブロッカー](#将来課題ブロッカー)

## マイルストーン

依存の向き（土台 → アプリ、`local` → `dev`）の順に並べる。時期は置かない（学習用のため）。

| マイルストーン | 目標 | 時期 |
|------|------|------|
| M1 仕様 | 02〜08・10 が揃い、設計レビューを通る | — |
| M2 開発基盤 | `npm test` / `npm run typecheck` / Lint が CI で必須チェックになる | — |
| M3 Lambda | 4 種の handler とスタブが UT で 02 の振る舞いを満たす | — |
| M4 土台（Terraform） | `local` に IAM・SQS・S3・Schedule group・SSM ができる | — |
| M5 アプリ（CDK） | `local` で実行を起動し、IT が通る | — |
| M6 実 AWS | `dev` で手動確認（08 #23）が通り、削除まで確かめる | — |

## タスク一覧

各タスクは着手時に issue を起票し、1 issue = 1 PR で進める。

| タスク | 状態 | 優先度 |
|--------|------|--------|
| なし（M1〜M6 の範囲は完了。今後の候補は「将来課題・ブロッカー」） | — | — |

## 完了済み（実績）

| タスク | 参照 |
|---|---|
| プロジェクトの初期化（ルール・静的解析・秘匿ファイル検出） | `7343b56` |
| アーキテクチャ仕様書（09） | #1 / #2 |
| スタック別ルールの追加 | #3 / #4 |
| 仕様書（02〜08・10・11） | #5 |
| 開発基盤（npm・tsconfig・ESLint + Prettier・Vitest・CI） | #7 |
| 入力スキーマ（Zod）とエラークラス | #9 |
| スタブ 5 種とインターフェース・構造化ロガー | #13 |
| handler（投入 / Consumer） | #14 |
| handler（データ連携 / Slack 通知）・Lambda の入口の共通化 | #15 |
| LocalStack の起動定義（Hobby プラン・認証トークン） | #17 |
| Terraform の土台と SSM 出力・Terraform の静的検査 | #18 |
| CDK スタック（Lambda・ステートマシン・Schedule・EventBridge rule）と CDK の UT | #20 |
| Slack 通知 Lambda が LocalStack の状態変化イベント（日時が文字列）を捨てる不具合の修正 | #30 |
| LocalStack 向けのデプロイ・実行スクリプト（`stack.sh` / `cdk.sh` / `batch.sh`）と IT（CI でも実行） | #21 |
| LocalStack で要検証の 2 点の確認（Scheduler は起動しない・状態変化イベントは届く）と `ABORTED` の IT | #22 |
| state バケットを作る冪等スクリプト（`tfstate-bucket.sh`）と IT | #19 |
| `dev`（実 AWS）へのデプロイ・手動確認・削除と、そこで見つかったスクリプトの不具合の修正 | #23 |
| Dependabot の設定（npm・GitHub Actions） | #16 |
| リポジトリの公開（MIT ライセンス）と、CI のマージ必須チェック（M2 の目標の達成） | #51 / #43 |

## 将来課題・ブロッカー

- 元資料「改善提案の候補」（DLQ アラーム・Consumer の冪等化・`waitForTaskToken`）は将来構成（09「将来構成」）
- Schedule の無効化・削除で実行が始まらないことに気づく手段は未決（#109。#101 の DLQ のアラームは、呼び出しが起きない失敗を拾わない）
- `aws-cdk-lib` 2.272.0 が同梱する `brace-expansion`（5.0.9）に高（high）の脆弱性（DoS）がある。開発時だけ使い、入力は自分のコードのグロブに限られるため実害は小さい。同梱のため外から更新できない。2.273.0 は修正版（5.0.12）を同梱しているため、Dependabot の `aws-cdk` グループの PR で取り込んで解消する
- Dependabot の対象外（Terraform provider・LocalStack のイメージ・`run:` 内のバージョン）は手で更新する（`.github/dependabot.yml` の冒頭）
