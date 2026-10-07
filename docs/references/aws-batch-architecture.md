# AWSバッチ構成の整理と確認事項

Oct 7, 2026 · @kojikawazu

> 本デモの元資料。原本からのコピーで、markdownlint 対応のため太字の小見出しを `###` に変えた以外は手を入れていない。`[embedded content: …]` は書き出し時に図が欠落した箇所で、図の題名だけが残っている。

## 概要

このバッチは、EventBridge Schedulerを起点にStep Functionsが段取りを組み、3つの流れ（失敗通知・メール送信・データ連携）で動く。最大の論点は、**メール送信のConsumer側で起きた失敗がSlack通知に乗らない可能性**があること。

本資料は、ヒアリングで分かった構成をシーケンスに起こし、現場で確認すべき点を洗い出したもの。実装コードはまだ読んでいないため、「要確認」と書いた箇所は推測を含む。

## 各サービスの役割

Schedulerが起動のきっかけ、Step Functionsが段取り（オーケストレーター）、Lambdaが実作業、SQS FIFOが順番待ちの列を担う。

| サービス | 役割 | オンプレでの近いもの | この案件での使われ方 |
| --- | --- | --- | --- |
| EventBridge Scheduler | 決まった時刻に起動する | crontab | Step Functionsを定時起動 |
| Step Functions | 自分では作業せず、順番・分岐・リトライ・実行履歴を管理する | 起動シェル（順に叩く、終了コードで分岐） | 投入Lambda・データ連携Lambdaを呼ぶ。失敗時は失敗イベントを出す |
| Lambda | 呼ばれたら処理して終わる短命なプログラム（最大15分） | Javaのバッチ本体 | 投入、Consumer、データ連携、Slack通知の4種類 |
| SQS FIFO | 作る側と処理する側の間のバッファ。順序保証と5分間の重複排除 | MQ、処理待ちテーブル | 送信待ちメールを1件ずつ保持し、Consumerが取り出して送る |
| EventBridge rule | イベントに反応して処理を呼ぶ | 監視ツールのアラート連携 | Step Functionsの失敗イベントでSlack通知Lambdaを呼ぶ |

**SQSを挟む理由**：1つのLambdaで大量のメールを送ると、15分の制限、途中失敗時に進捗が分からない、SendGridのレート制限、といった問題が出る。SQSを挟むと1件ずつ独立して処理・リトライでき、失敗し続けたものだけがDLQに隔離される。FIFOを選んだ理由（順序が必要な業務要件があるか）は要確認。

**2つの連携スタイルが混在している**：Step Functionsが順番を決める部分は「オーケストレーション」、SQSに積まれたらConsumerが動く・失敗イベントでSlack通知が動く部分は、各自がイベントに反応する「コレオグラフィ」。後述のリスク1（Consumerの失敗が通知されない）は、この境目で起きている。

## IaCの責務分担

変更頻度の低い土台をTerraform、頻繁に変わるアプリ側をCDKが持つ。CDKはTerraformが作ったリソースを参照する側なので、デプロイは常に Terraform → CDK の順になる。

| リソース | 管理ツール | 役割 |
| --- | --- | --- |
| VPC / Security Group | Terraform | ネットワークの土台 |
| IAMロール | Terraform | Lambda実行、Step Functions、Scheduler用 |
| SQS FIFO（+ DLQ） | Terraform | メール送信キュー |
| Schedule group | Terraform | スケジュールの入れ物 |
| Schedule定義 | CDK | cron式とターゲット |
| Step Functions | CDK | ステートマシン |
| Lambda | CDK | 各処理の本体 |

### この分担で生じる運用上の注意

- Lambdaやステップを追加するとき、IAMの権限追加（Terraform）が先に必要になり、変更が2リポジトリにまたがる。
- CDKは `grant*` 系で自動的にポリシーを足そうとするため、既存ロールを `mutable: false` で参照しているか要確認。
- TerraformからCDKへのARN・IDの受け渡し方法（SSM Parameter Store、ハードコード等）と、環境ごとの切り替え方が要確認。

### デプロイの流れ

&#91;embedded content: デプロイの流れ · Terraform段階 → CDK段階\]

SSM Parameter Storeでの受け渡しは推測。ハードコードの場合は3と5が無く、環境ごとの値をCDK側で持つ。IAM変更を伴う追加は、1〜3が適用されてから4以降を流す。

## 実行フロー

起動はすべてEventBridge SchedulerからStep Functions。その先が3つの流れに分かれ、失敗の伝わり方がそれぞれ違う。

### ① 失敗通知

&#91;embedded content: 失敗通知 · Scheduler → Step Functions → EventBridge rule → Slack\]

Step Functionsは自分では通知しない。実行状態の変化イベントをEventBridge ruleが拾い、Slack通知Lambdaを呼ぶ。

### ② メール送信

&#91;embedded content: メール送信 · Step Functions → 投入Lambda → SQS FIFO → Consumer → SendGrid\]

SQS投入後の5と6はStep Functionsの外で動く。ここでの失敗は①の通知に乗らない（リスク1）。

### ③ データ連携

&#91;embedded content: データ連携 · Step Functions → Lambda → MySQL / BigQuery / S3 / Cuenote FC\]

Lambdaの失敗はStep Functionsの失敗になり、①の通知に乗る。Lambdaが1つか接続先ごとに分かれているかは要確認。

## リスクと論点

影響が大きい順に4つ。1と2はメールが届かない・二重に届くという利用者に見える障害につながる。

### 1. Consumer側の失敗が通知されない

Step Functionsは、投入LambdaがSQSに積んで正常終了した時点で成功扱いになる。その後Consumer LambdaやSendGridで失敗してDLQに落ちても、Step Functionsの失敗イベントは出ないため、EventBridge rule経由のSlack通知には乗らない。DLQへのアラームが無ければ「バッチは成功なのにメールが届いていない」状態に誰も気づけない。

### 2. 二重投入・二重送信

- **投入側**：投入Lambdaが途中で例外終了し、Step FunctionsのRetryで再実行されると、途中までのメッセージが再投入される。`MessageDeduplicationId` を業務キーから決定的に作っていれば5分以内は重複排除が効くが、UUIDを毎回生成していると効かない。
- **消費側**：ConsumerがSendGridに送った直後に落ちるとメッセージが再配信され、同じメールが再送される。FIFOの重複排除は送信時点の話で、消費側の二重処理は防げない。
- 5分を超えたリトライや手動の再実行には、どの方式でもFIFOの重複排除は効かない。最後の防波堤はConsumer側の冪等性（送信済みチェック）になる。

### 3. ネットワークと認証

- LambdaがVPC内にある場合、SendGrid・BigQuery・Cuenote FCといった外部SaaSへの出口としてNAT Gatewayが必要。
- BigQueryはGCPのため、AWSからの認証方法（サービスアカウントキーをSecrets Managerに置くか、Workload Identity Federationか）が論点。キー方式ならローテーション運用が発生する。
- MySQLの所在（RDS、オンプレ等）によって接続経路が変わる。

### 4. データ連携の途中失敗

データ連携Lambdaは同期実行なので、失敗すればSlack通知には乗る。ただし複数の外部接続を順に行う場合、途中で落ちると「S3にファイルだけ残る」「Cuenote FCに一部だけ登録される」といった中途半端な状態が残りうる。再実行で安全にやり直せる作りになっているかが論点。

## 現場での確認事項

読む順番は、Terraformのoutputs → CDKのロール参照 → Step Functions定義 → デプロイ手順が効率的。

### 通知まわり

- [ ] EventBridge ruleのイベントパターンが拾う状態（`FAILED` / `TIMED_OUT` / `ABORTED`）
- [ ] DLQのメッセージ数に対するCloudWatchアラームの有無
- [ ] Consumer Lambda内で失敗時にSlack通知しているか

### 二重送信まわり

- [ ] 投入Lambdaの `MessageDeduplicationId` の生成方法
- [ ] Step Functionsの投入Lambdaタスクに付いている `Retry` 設定
- [ ] Consumer側で送信済みチェックをしているか
- [ ] SQSの可視性タイムアウトとConsumer Lambdaのタイムアウトの関係、`ReportBatchItemFailures` の利用

### データ連携まわり

- [ ] データ連携のLambdaは1つか、接続先ごとに分かれているか
- [ ] MySQL / BigQuery / S3 / Cuenote FC それぞれの読み書きの向きと呼び出し順
- [ ] BigQueryの認証方式と鍵の保管場所
- [ ] 外部への出口（NAT Gateway）の有無

### IaC・運用まわり

- [ ] TerraformからCDKへの値の受け渡し方法
- [ ] CDKが既存IAMロールにポリシーを追加しない設定か
- [ ] Terraform → CDK のデプロイ順をCIでどう担保しているか
- [ ] メール配信がSendGridとCuenote FCの2系統ある理由（用途分けか、移行途中か）

## 改善提案の候補

確認の結果、穴が実際にあった場合の提案。変更が小さく効果が大きい順に並べている。

| 順 | 提案 | 効くリスク | 変更範囲 |
| --- | --- | --- | --- |
| 1 | DLQのメッセージ数にCloudWatchアラームを設定し、既存のSlack通知Lambdaに流す | 通知されない | Terraform中心、小 |
| 2 | `MessageDeduplicationId` を業務キー（配信ID等）から決定的に生成する | 二重投入 | 投入Lambda、小 |
| 3 | Consumerで送信済みチェックを入れ、冪等にする | 二重送信 | Consumer + 状態保存先、中 |
| 4 | 投入を `waitForTaskToken` 方式に変え、Consumerの結果をStep Functionsに返す | 通知されない | Step Functions + Consumer、大 |

4は根本対応だが、タイムアウト設定が必須になり、実行時間とコストも増える。まずは1〜3で十分なことが多い。
