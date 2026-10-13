# 要求仕様書

プロジェクトの背景・目標・スコープ・制約を定義する。機能の詳細要件は [`02-requirements-specification.md`](./02-requirements-specification.md) を参照。

## 目次

- [背景・目的](#背景目的)
- [ステークホルダー](#ステークホルダー)
- [スコープ](#スコープ)
- [制約・前提](#制約前提)
- [主要な決定事項](#主要な決定事項)

## 背景・目的

学習用に想定した AWS バッチ構成（[元資料](references/aws-batch-architecture.md)）を、手元で実際に動かして試すためのデモ。

資料は構成とシーケンスを文章と図で起こしたもので、実装コードは読んでいない。サービス同士がどうつながり、失敗がどう伝わるかを、動くもので確かめるのがゴール。

本番の DB やメール配信には接続しない。構成の流れを体験できれば十分とする。

## ステークホルダー

| 役割 | 説明 |
|------|------|
| 開発者（学習者） | デモを構築・実行し、元資料の構成を理解する |

## スコープ

元資料の構成を次の範囲で再現する。

- **起動**: EventBridge Scheduler が Step Functions を定時起動する
- **① 失敗通知**: Step Functions の失敗イベントを EventBridge rule が拾い、Slack 通知 Lambda を呼ぶ
- **② メール送信**: 投入 Lambda → SQS FIFO（+ DLQ）→ Consumer Lambda → メール送信スタブ
- **③ データ連携**: データ連携 Lambda → MySQL / BigQuery / S3 / Cuenote FC の各スタブ
- **IaC の責務分担**: 土台（IAM・SQS・Schedule group 等）を Terraform、アプリ（Lambda・Step Functions・Schedule 定義）を CDK で管理し、Terraform → CDK の順にデプロイする
- **LMI（学習目的。#62）**: データ連携 Lambda を Lambda Managed Instances で動かし、Step Functions から Lambda の 15 分の上限を越える実行を待つ。元資料には無く、必要からではなく構成を体験するために足す。設計は 09「LMI（Lambda Managed Instances）」、実装は #63

### スコープ外（将来拡張）

- 本番の DB・メール配信・SaaS への接続（すべてスタブで代替する）
- 元資料「リスクと論点」の再現と「改善提案の候補」の実装（必要になったら追加する）
- 業務ロジック・実データ

## 制約・前提

- 外部サービス（SendGrid / BigQuery / Cuenote FC / MySQL / Slack）は**すべてスタブ**にする。実在の宛先へは何も送らない
- 同じ IaC を **LocalStack（ローカル検証）と実 AWS アカウント（動作確認）の両方**へデプロイできるようにする
- 実 AWS では常時課金されるリソースを作らない（NAT Gateway 等）。LMI の EC2 のように存在する間は課金されるものは、検証の間だけ作り、確かめたら削除する（2026-10-13 に緩和。#48）。詳細は 09「費用」を参照
- 技術スタックの詳細は [09 アーキテクチャ仕様書](09-architecture-specification.md) を参照

## 主要な決定事項

| 決定事項 | 理由 |
|---|---|
| 外部サービスはすべてスタブ | 目的は構成の体験であり、実データ・実配信は不要なため |
| ローカル（LocalStack）と実 AWS の両方で動かす | 費用ゼロで繰り返し試し、最後に本物の挙動を確認するため |
| Terraform + CDK の 2 段構成を再現する | 元資料の論点（デプロイ順・既存ロールの参照）も構成の一部として体験するため |
| LMI を使う（学習目的） | Lambda の 15 分の上限と、それを越える構成（LMI・非同期の呼び出し・`waitForTaskToken`）を動かして確かめるため。存在する間は EC2 の料金がかかるため、検証の間だけ作る |
