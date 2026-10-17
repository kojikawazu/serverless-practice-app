# LMI（Lambda Managed Instances）解説

Lambda Managed Instances（LMI）とは何か、通常の Lambda と何が違うか、このプロジェクトでなぜ・どう使い、動かして何が分かったかをまとめる。通常の Lambda の仕組み（実行環境・呼び出し方・版と修飾子）は [Lambda 解説](lambda.md)を前提にする。このプロジェクト固有の決定（使う段・設定・費用の上限）は [09 アーキテクチャ仕様書](../09-architecture-specification.md#lmilambda-managed-instances)が正本で、実測した事実は 09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」と[教訓ログ](../lessons-learned.md)が正本。本書はそれらを参照し、本文を複製しない。

公式ドキュメントの記述は「公式」と書いて出典を添える（2026-10-17 に確認）。

## 目次

- [LMI とは](#lmi-とは)
- [仕組み](#仕組み)
- [通常の Lambda との違い](#通常の-lambda-との違い)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [動かして分かったこと](#動かして分かったこと)
- [費用と消し忘れ](#費用と消し忘れ)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## LMI とは

Lambda の関数を、**自分のアカウントの EC2 インスタンス**の上で動かす仕組み。関数の書き方・呼び出し方は Lambda のままで、インスタンスの起動・OS とランタイムのパッチ・終了・台数の調整は AWS（Lambda）が持つ（公式）。インスタンスを直接終了させることはできず、消すにはキャパシティプロバイダ（下記）を消す（公式）。

公式が向いている用途に挙げるのは、急な増減の無い定常的な高負荷・最新の CPU やメモリと CPU の比率を選びたい性能重視の処理・VPC やインスタンスの置き場所を統制したい場合など。逆に、負荷が急に増減する・普段は呼ばれずゼロまで縮めたい関数は、通常の Lambda が向く（公式）。

**長時間の処理は、公式の用途の一覧には入っていない。** ただし、非同期の呼び出しとイベントソースマッピングでは最大 90 分まで動ける（同期の呼び出しは 15 分のまま。公式）。このプロジェクトが LMI を使うのは、この 90 分のため（下記「このプロジェクトで使う理由」）。

## 仕組み

### 構成要素

```text
キャパシティプロバイダ ── どこで・何を・何台まで動かすか
  ├ VPC の設定（サブネット 1〜16 個・セキュリティグループ）
  ├ オペレーター用ロール（Lambda が EC2 を起動・監視するための IAM ロール）
  ├ インスタンスの条件（アーキテクチャ・使う/使わないインスタンスタイプ）
  └ スケーリングの設定（vCPU の上限など）
        ▲
        │ 紐付ける
関数 ──┘ 版を発行すると、プロバイダのインスタンスの上で実行環境が起動する
```

- **オペレーター用ロール**: 最低限、AWS 管理ポリシー `AWSLambdaManagedEC2ResourceOperator` の権限が要る（公式）。インスタンスの寿命の終わりの終了は、別のサービスリンクロール（`AWSServiceRoleForLambda`）が行う
- **ネットワーク**: 関数のコードが AWS のサービスへ届くにも、ログを CloudWatch Logs へ送るにも、VPC から外へ出る経路（IGW・NAT Gateway・VPC エンドポイントのいずれか）が要る（公式）。このプロジェクトの選び方は 09「[ネットワーク](../09-architecture-specification.md#ネットワーク)」を参照
- **インスタンスの寿命**: 最大 14 日で入れ替わる。開発者ガイドには数値が無く、公式ブログ（参考資料）にある

### 版を発行して初めて動く

LMI の関数は、**版を発行しないと動かない**（公式）。版を発行すると、Lambda がインスタンスを起動し、実行環境を用意してから、その版を使える状態（`ACTIVE`）にする。

番号付きの版を管理しない使い方のために、LMI には `$LATEST.PUBLISHED` という版がある（公式）。`publish-version --publish-to LATEST_PUBLISHED` で作り、同じ名前のまま中身を出し直せる。CloudFormation（CDK を含む）やコンソールで LMI の関数を作ると、自動で作られる。

**修飾子なしの ARN で呼ぶと、`$LATEST` ではなく `$LATEST.PUBLISHED` が呼ばれる**（公式）。通常の Lambda では修飾子なしは `$LATEST` を呼ぶ（[Lambda 解説](lambda.md#版と修飾子)）ため、ここが大きな違い。

### 1 つの実行環境で複数の呼び出しを並行に処理する

通常の Lambda では 1 つの実行環境は一度に 1 つの呼び出しだけを処理するが、LMI では **1 つの実行環境が複数の呼び出しを同時に処理する**（公式）。

| ランタイム | 1 環境の同時の呼び出し数の既定（公式） | 共有されるもの |
|---|---|---|
| Node.js | vCPU あたり 64 | 同じワーカースレッドで処理される呼び出しは、ハンドラーとグローバル状態を共有する |
| Python | vCPU あたり 16 | 呼び出しごとに別のプロセスで、メモリ上の状態は共有しない |
| Java | vCPU あたり 32 | スレッドで並行に処理する |

`/tmp` はどのランタイムでも、同じ環境の呼び出しの間で共有される（公式）。グローバル変数に呼び出しごとの値を置く書き方は、通常の Lambda では動いても LMI では壊れる。

### スケーリング

- **既定は 3 環境・3 つの AZ**: 可用性のため、既定で 3 つの実行環境を AZ に分けて起動してから、版を `ACTIVE` にする。最小の既定は 3、最大の既定は無し（公式）。関数のスケーリングの設定で最小・最大を変えられ、両方を 0 にすると関数を止められる
- **呼び出しが来てから増やすのではない**: 使用率を見て事前に増やすため、コールドスタートは無い。代わりに、5 分の間に呼び出しが 2 倍を超えて増えるとスロットルされうる（公式）
- **ゼロまで縮まない**: 呼び出しが無くても、最小の実行環境数までしか減らない（公式）。動かしていない間もインスタンスの料金がかかる
- スケールの指標は、公式の中でも書き方がそろっていない（「CPU の使用率と並行数の飽和」「CPU の使用率だけ」「CPU とメモリの使用率」）。本書では断定しない

## 通常の Lambda との違い

| 観点 | 通常の Lambda | LMI（公式） |
|---|---|---|
| 動く場所 | AWS が用意する実行環境 | 自分のアカウントの EC2 インスタンス |
| 課金 | リクエスト数 + 実行時間（GB 秒） | リクエスト数 + EC2 のインスタンスの時間 + 管理料（EC2 のオンデマンド料金の 15%）。実行時間の課金は無い。Savings Plans などの割引は EC2 の部分だけに効く |
| 呼ばれないとき | 実行環境は消え、費用はかからない | 最小の実行環境数まで残り、インスタンスの費用がかかり続ける |
| 1 環境の呼び出し | 一度に 1 つ | 複数を並行に処理する |
| タイムアウトの上限 | 15 分 | 非同期の呼び出しとイベントソースマッピングは 90 分（Amazon MQ・DocumentDB を除く）。同期は 15 分 |
| タイムアウトしたとき | 実行は止められる | **コードは止まらず、裏で動き続ける。** 呼んだ側にはタイムアウトのエラーが返り、非同期なら既定で 2 回再試行される |
| 最小の大きさ | メモリ 128 MB から | 2 GB・1 vCPU から |
| 隔離の単位 | 実行環境ごと | **キャパシティプロバイダがセキュリティの境界。** 同じプロバイダの関数どうしは、コンテナでは隔離されない |
| 使えるランタイム | ほぼすべて | Node.js 22 以降・Python 3.13 以降・Java 21 以降・.NET 8 以降など |

**タイムアウトしてもコードが止まらない**ことは、副作用のある処理で特に効く。公式は、タイムアウトの後も書き込みや通知が続き、呼んだ側の再試行と重なって二重になる例を挙げ、残り時間を見て自分で打ち切るよう求めている。

## このプロジェクトで使う理由

学習目的で、Lambda の 15 分の上限を LMI でどう越えるかを動かして確かめる（01「[スコープ](../01-business-requirements.md#スコープ)」）。今の処理に 15 分を超えるものは無く、必要だからではない。

- **LMI で動かすのはデータ連携 Lambda だけ。** Step Functions から非同期で呼び、関数がタスクトークンで結果を返す（09「[対象の段と呼び出し方](../09-architecture-specification.md#対象の段と呼び出し方)」）。非同期にするのは、90 分まで動けるのが非同期の呼び出しだけだから
- **処理時間で実行先を決める**: 15 分未満は通常の Lambda、15〜90 分は LMI、90 分超は分割する（09「[処理時間ごとの実行先](../09-architecture-specification.md#処理時間ごとの実行先)」）
- **`dev` でだけ作り、検証の間だけ動かす**: 動かしている間はインスタンスの料金がかかるため（09「[費用と消し忘れへの備え](../09-architecture-specification.md#費用と消し忘れへの備え)」）
- 設定（アーキテクチャ・インスタンスタイプ・vCPU の上限・実行環境数・メモリ）と理由は 09「[キャパシティプロバイダと関数の設定](../09-architecture-specification.md#キャパシティプロバイダと関数の設定)」、Terraform と CDK の分担は 09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」を参照

LMI の 2 つの性質への対策が、設計に入っている。

| 性質（公式） | このプロジェクトの対策 |
|---|---|
| タイムアウトしてもコードは止まらない | ステートマシン側の `DataSync` タスクに、関数のタイムアウトより長いタイムアウトとハートビートを置き、待ち続けない（09「[タイムアウト](../09-architecture-specification.md#タイムアウト)」）。データ連携 Lambda は残り時間を見て打ち切ってはいない（コードで確認）。検証用に待つ秒数の上限（1,200 秒）を、関数のタイムアウト（1,800 秒）より短くしている |
| 非同期の呼び出しは、タイムアウトや失敗で既定 2 回再試行される | 非同期の再試行を 0 にし、同じタスクトークンで処理が二重に走らないようにする。やり直しは Step Functions の `Retry` に任せる（[Lambda 解説](lambda.md#失敗したときに誰がやり直すか)） |
| 1 つの環境で呼び出しがグローバル状態を共有する | データ連携 Lambda がモジュールに持つのは、状態を持たない S3 クライアントと読み取り専用の定数だけ（09「[キャパシティプロバイダと関数の設定](../09-architecture-specification.md#キャパシティプロバイダと関数の設定)」） |

## 動かして分かったこと

`dev` で動かして（2026-10-15〜17。#66・#70・#71・#72）、公式の記述だけでは読み取れなかったことが分かった。数値と確かめ方は 09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」の「LMI」が正本。

| 分かったこと | 意味 | 正本 |
|---|---|---|
| **台数は設定どおりにすぐには減らない。** 実行環境数を最小・最大 1 にしても、起動直後は既定どおり 3 台・3 環境で始まり、しばらくしてから 1 台に減った | 費用の見積もりも消し忘れの見積もりも、「3 台の間」と「1 台になった後」を分けて考える | 09「[`dev` での検証結果](../09-architecture-specification.md#lmi2026-10-1766)」 |
| **`$LATEST.PUBLISHED` で動いても、非同期の設定は呼ぶ側の修飾子で決まる。** 修飾子なしの呼び出しは `$LATEST.PUBLISHED` で動いたが、効いた再試行の設定は `$LATEST` のものだった | 公式は「修飾子なしは `$LATEST.PUBLISHED` を呼ぶ」とだけ書き、非同期の設定がどの版のものかは書いていない。設定は「動いた版」ではなく「呼ぶ側の修飾子」から辿る | 09「[`dev` での検証結果](../09-architecture-specification.md#lmi2026-10-1766)」・教訓ログ「[LMI の非同期の再試行設定を『付いている版』から推論し、効いていないと誤認した](../lessons-learned.md#2026-10-17-lmi-の非同期の再試行設定を付いている版から推論し効いていないと誤認した)」 |
| **インスタンスは EC2 の一覧に出ない。** `describe-instances` の既定の応答には出ず、`--include-managed-resources` を付けたときだけ出た | 公式によると、AWS のサービスが代わりに作るリソース（managed resources）は、表示設定ができる前に持っていなかったアカウントでは既定で隠れる。数えるときは付け、消した後は `terminated` が見えることで空振りでないことを確かめる | 教訓ログ「[LMI のインスタンスが describe-instances の既定の応答に出ず、動いているのに 0 台に見えた](../lessons-learned.md#2026-10-17-lmi-のインスタンスが-describe-instances-の既定の応答に出ず動いているのに-0-台に見えた)」 |
| **キャパシティプロバイダのロググループは、LMI が自動で作り、消しても残った。** 名前は `/aws/lambda/capacity-provider/<プロバイダ名>` | IaC で同じ名前のロググループを先に作り、消すときはプロバイダの削除が終わってから消す。最後のインスタンスは、関数を消しても終わらず、プロバイダの削除の後に終わることがあった | 09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」 |
| **台数が減った後の、最も安い消し忘れで予算の額を決める。** 許可したタイプのうち安い方が選ばれ、1 台に減った後の費用で、予算の通知を確実に越える額にした | 見積もり（上限を知る）とアラート（確実に捕まえる）では、見るべき端が逆になる | 09「[額の決め方](../09-architecture-specification.md#額の決め方)」・教訓ログ「[予算アラートの額を最悪の費用で決め、最も安い消し忘れでは越えない額にしていた](../lessons-learned.md#2026-10-17-予算アラートの額を最悪の費用で決め最も安い消し忘れでは越えない額にしていた)」 |

このほか、`.waitForTaskToken` と `InvocationType: "Event"` の併用（公式の例が見つからなかった）が動くこと、15 分を超えて動いている間に認証情報・接続が切れないことも確かめた（09「[`dev` での検証結果](../09-architecture-specification.md#lmi2026-10-1766)」）。

## 費用と消し忘れ

- **費用の形**: インスタンスの時間課金・管理料・パブリック IPv4（パブリックサブネットに置く場合）が、動いている間かかり続ける。呼ばれていなくても、最小の実行環境数のインスタンスが残る
- **確実に止める手段は、キャパシティプロバイダの削除だけ**（公式）。プロバイダは関数の版が紐付いている間は消せないため、関数（CDK）→ プロバイダ（Terraform）の順に消す。このプロジェクトの削除の順序（CDK → Terraform）はこれと一致する（09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」）
- **消し忘れへの備え**: AWS Budgets の日次の予算アラートで、1 台のまま消し忘れても通知が出るようにしている。通知が出るのは、消し忘れた時刻によってその日か翌日の分で、予算の更新の遅れも加わる（09「[予算アラート](../09-architecture-specification.md#予算アラート)」・「[額の決め方](../09-architecture-specification.md#額の決め方)」）

## LocalStack との違い

このプロジェクトが使う LocalStack の今のライセンス（Hobby プラン）では、LMI の API（`CreateCapacityProvider`）を使えなかった（2026-10-13 に確認）。そのため、LMI の部分（VPC・キャパシティプロバイダ・関数の紐付け）は `dev` でだけ作り、`local` のデータ連携 Lambda は通常の関数として動かす（09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」）。

`local` でも、呼び出し方（非同期 + タスクトークン）・ハートビート・結果の返し方は `dev` と同じなので、IT で確かめられる。15 分を超える実行・台数・費用・ロググループの自動作成は、`dev` でしか確かめられない。

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| LMI が動いているはずなのに、`describe-instances` が 0 件 | managed resources として隠れている。`--include-managed-resources` を付ける（上記「動かして分かったこと」） |
| `down` の後も、ロググループ `/aws/lambda/capacity-provider/...` が残り、保持期間が無期限 | LMI が自動で作ったもの。IaC で先に作り、プロバイダの後に消す |
| 版を発行していない関数が、キャパシティプロバイダで動かない | LMI は版を発行して初めて動く。CDK・CloudFormation なら `$LATEST.PUBLISHED` が自動で作られる |
| タイムアウトの後も、書き込みや通知が続いて二重になる | LMI はタイムアウトしてもコードを止めない。残り時間を見て打ち切るか、呼ぶ側で必ずタイムアウトを置き、非同期の再試行を絞る |
| 呼び出しが急に増えたときにスロットルされる | 事前にスケールする方式で、5 分で 2 倍を超える急増には追いつかない。最小の実行環境数を上げておく |
| Terraform で関数のタイムアウトを 900 秒より長くできない | Terraform の AWS provider は関数のタイムアウトを 900 秒までしか受け付けない（2026-10-13 時点）。このプロジェクトは関数を CDK に置いている（09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」） |
| ランタイム同梱の AWS SDK では動かない | LMI は AWS SDK for JavaScript v3 の 3.933.0 以上を求める。SDK をバンドルに含め、ESM の出力では `require` を用意する（09「[実装で設計から変えた点](../09-architecture-specification.md#実装で設計から変えた点)」） |

## 参考資料

- [Lambda Managed Instances](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances.html)（概要・向いている用途・通常の Lambda との比較・料金の割引）
- [Capacity providers](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-capacity-providers.html)・[Operator role](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-operator-role.html)
- [$LATEST.PUBLISHED version](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-version-publishing.html)（修飾子なしの呼び出し）
- [Understanding the Lambda Managed Instances execution environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-execution-environment.html)（並行処理・タイムアウトしても止まらないこと）
- [Scaling](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-scaling.html)（既定の 3 環境・最小の大きさ・スロットル）
- [Node.js runtime for Lambda Managed Instances](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-nodejs-runtime.html)（並行数の既定・グローバル状態の共有）
- [Security](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-security.html)（キャパシティプロバイダがセキュリティの境界）
- [Networking](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-networking.html)
- [Capacity provider logs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-monitoring-cwl.html)（ロググループの名前）
- [Supported runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-runtimes.html)
- [Amazon EC2 managed instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-managed-instances.html)（managed resources が隠れる条件）
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)（管理料 15%・実行時間の課金が無いこと）
- [Introducing AWS Lambda Managed Instances](https://aws.amazon.com/blogs/aws/introducing-aws-lambda-managed-instances-serverless-simplicity-with-ec2-flexibility/)（公式ブログ。インスタンスの寿命 最大 14 日）
- [Announcing 90-minute function timeout on AWS Lambda Managed Instances](https://aws.amazon.com/blogs/compute/announcing-90-minute-function-timeout-on-aws-lambda-managed-instances/)（公式ブログ。同期は 15 分のまま）
