# SSM Parameter Store 解説

AWS Systems Manager の Parameter Store とは何か、どう動くか、このプロジェクトでなぜ・どう使うかを、Terraform から CDK への値の受け渡しを例にまとめる。このプロジェクト固有の決定（パラメータの一覧・名前・型・読む側）は [05 データ仕様書](../05-data-specification.md#ssm-パラメータ)が正本で、書く側の実体は `infra/terraform/ssm.tf`、読む側は `infra/cdk/lib/batch-stack.ts` の `ssmValue`。本書はそれらを参照し、本文を複製しない。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-11-08 に確認）、このプロジェクトで確かめたことは 05・09 を参照する。

## 目次

- [Parameter Store とは](#parameter-store-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## Parameter Store とは

名前と値の組（**パラメータ**）を置いておき、ほかのサービスやプログラムから名前で読むためのサービス。設定値・リソースの ID・接続先などを、コードやテンプレートに直接書かずに 1 か所に置ける。

名前は `/serverless-practice-app/dev/queue/url` のように `/` で区切った階層にでき、接頭辞でまとめて扱える。

## 仕組み

### 型と層

| 型 | 中身 |
|---|---|
| `String` | 文字列 1 つ |
| `StringList` | カンマ区切りの文字列の並び |
| `SecureString` | KMS の鍵で暗号化した文字列。パスワードなどの秘匿値に使う |

パラメータには層（tier）があり、何も指定しなければ**標準（Standard）**になる（公式「Choosing parameter tiers in Parameter Store」）。

| | 標準 | アドバンスト |
|---|---|---|
| 1 アカウント・リージョンあたりの数 | 10,000 | 100,000 |
| 値の最大サイズ | 4 KB | 8 KB |
| 料金 | 追加料金なし | 課金される |
| パラメータポリシー（期限など） | 使えない | 使える |

標準からアドバンストへは上げられるが、下げられない（同じページ）。

### CloudFormation から読む

CloudFormation のテンプレートは、パラメータの型に `AWS::SSM::Parameter::Value<String>` を指定すると、**Parameter Store の名前を受け取って、その値を使う**（公式「Specify existing resources at runtime with CloudFormation-supplied parameter types」）。

- 値を読むのは、**スタックを作る・更新する・変更セットを作るとき**。そのとき Parameter Store にある値を使う
- 読んだ値はスタックに固定される。**後から Parameter Store の値が変わっても、次にスタックを更新するまで反映されない**
- 指定した名前のパラメータが無ければ、検証エラーになる
- `SecureString` は、この方法では読めない（動的参照という別の方法を使う）

CDK の `ssm.StringParameter.valueForStringParameter` は、この仕組みを使う。合成したテンプレートには、値ではなく型 `AWS::SSM::Parameter::Value<String>` のパラメータが入り、その既定値がパラメータの名前になる（[CDK 解説](cdk.md#別のスタックterraformの値を-ssm-から読む)）。

## このプロジェクトで使う理由

土台（IAM・SQS・S3・Schedule group など）は Terraform、アプリ（Lambda・ステートマシン・Schedule 定義など）は CDK が作る（09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」）。CDK の側は、Terraform が作ったものの ARN・名前・URL を知る必要がある。

元資料は、この受け渡しの方法を「要確認」とし、Parameter Store を推測として挙げていた（[元資料](../references/aws-batch-architecture.md)）。このデモはそれを採用した（09「[技術スタック](../09-architecture-specification.md#技術スタック)」）。

```text
Terraform（ssm.tf）                      Parameter Store                       CDK（batch-stack.ts）
for_each で 1 つのマップから書く  ──▶  /serverless-practice-app/<stage>/...  ◀──  ssmValue(name) で参照する
                                                                                 （デプロイ時に CloudFormation が値を読む）
```

| 項目 | このプロジェクト | 正本 |
|---|---|---|
| 名前 | `/serverless-practice-app/<stage>/<name>`。ステージで階層を分ける | 10「[命名](../10-miscellaneous-specification.md#コーディング規約命名)」 |
| 数 | `local` は 15、`dev` は LMI のキャパシティプロバイダの分を足して 16 | 05「[SSM パラメータ](../05-data-specification.md#ssm-パラメータ)」 |
| 型・層 | すべて `String`・標準。秘匿値を置かないため `SecureString` は使わない | 同上 |
| 中身 | キュー・DLQ・バケット・Schedule group の ARN と名前、IAM ロールの ARN、Consumer のタイムアウト（秒） | 同上 |
| 読み方 | デプロイ時に読む（`valueForStringParameter`）。合成時に読む方式（`valueFromLookup`）は使わない | 同上 |

ステージの値（`local` / `dev`）は名前の中にだけ現れ、値そのものはステージをまたがない。`local` の CDK は `/serverless-practice-app/local/...` だけを読む。

## 特徴と制約

### 合成時ではなく、デプロイ時に読む

CDK には、合成の時点で Parameter Store を読んで値をテンプレートに埋め込む方式（`valueFromLookup`）もある。このプロジェクトは使わない。合成時に読んだ値は `cdk.context.json` にキャッシュされ、ステージ間で混ざりうるため（05「[SSM パラメータ](../05-data-specification.md#ssm-パラメータ)」）。

デプロイ時に読む方式では、合成したテンプレートに値が残らず、名前だけが残る。そのため、CDK の UT は値ではなく**パラメータの名前**を確かめている（[CDK 解説](cdk.md#別のスタックterraformの値を-ssm-から読む)）。

### 値が変わったら、CDK のスタックを更新し直す

CloudFormation は、スタックを更新するときにだけ Parameter Store を読む（上記）。Terraform が作り直しなどで値（キューの URL など）を変えても、**CDK のスタックはデプロイし直すまで古い値を使い続ける**。

このプロジェクトでは、`stack.sh <stage> up` が Terraform → CDK の順に流すため、通常の手順では食い違わない（09「[デプロイ](../09-architecture-specification.md#デプロイ)」）。Terraform だけを `apply` して値が変わったときは、続けて `cdk.sh <stage> deploy` を流す。

テンプレートが変わっていなくても、CDK CLI はデプロイを飛ばさない。CDK CLI 2.1145.0 のソース（`canSkipDeploy`）は、パラメータが SSM から来るスタックについて「値が変わったかもしれないとみなす」として、変更セットを作りに行く（2026-11-08 にソースで確認。実際に値を変えてデプロイし直したことはない）。

### 無いパラメータを読むと、デプロイが失敗する

CloudFormation は、指定した名前のパラメータが無いと検証エラーにする（上記）。LMI のキャパシティプロバイダの ARN（`capacity-provider/arn`）は `dev` にしか書き出さないため、CDK も `dev` のときだけ読む。この条件は Terraform と CDK の 2 か所にある。ずれて「CDK は読むのに Terraform は書いていない」ステージができると、そのステージのデプロイがこのエラーで止まる（逆に、書いたのに読まないだけなら止まらない。[Terraform 解説](terraform.md#count-の条件はcdk-と-2-か所にある)）。

### 数値も文字列で渡す

パラメータの型は `String` だけなので、Consumer のタイムアウト（`consumer/timeout-seconds`）も文字列で書く。CDK は `Token.asNumber` で数値として扱い、デプロイ時に Lambda のタイムアウトとして解決される（LocalStack へのデプロイで確かめた。#20。05「[SSM パラメータ](../05-data-specification.md#ssm-パラメータ)」）。値の正本は Terraform にあり、SQS の可視性タイムアウトはその 6 倍（04「[パフォーマンス要件](../04-non-functional-specification.md#パフォーマンス要件)」の「連動するパラメータ」）。

### 書き出しても、CDK が読まないものがある

`dlq/arn`（メール送信キューの DLQ の ARN）は、CDK のどこからも読まれていない。05 は「参照のみ（確認用）」としている。CDK が DLQ のアラームに使うのは、キュー名の `dlq/name`（#135）。

### 料金

標準のパラメータは追加料金なし（上記）。このデモは 15〜16 個で、上限の 10,000 にも 4 KB にも遠い。

## LocalStack との違い

| 違い | 正本 |
|---|---|
| Parameter Store は `local` でも動き、CloudFormation のデプロイ時の解決（数値への変換を含む）も通った | 05「[SSM パラメータ](../05-data-specification.md#ssm-パラメータ)」（#20） |
| 既定で IAM を評価しないため、パラメータを読む権限の過不足は分からない | [IAM 解説](iam.md#localstack-との違い) |

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| Terraform で作り直したキューに、Lambda が古い URL で送ろうとする | CDK のスタックが、前のデプロイ時に読んだ値を持ち続けている。`cdk.sh <stage> deploy` で更新し、CloudFormation に読み直させる |
| CDK のデプロイが、パラメータが見つからないという検証エラーで失敗する | Terraform がまだ `apply` されていない、ステージを取り違えた、または `dev` だけのパラメータを別のステージで読もうとしている。`stack.sh` で Terraform → CDK の順に流す |
| 合成したテンプレートを見ても、ARN の値が書かれていない | デプロイ時に読む方式なので、テンプレートには名前しか入らない。値はスタックの「パラメータ」で確かめる（`describe-stacks`） |
| 秘匿値を置こうとして、CloudFormation のパラメータで読めない | `SecureString` はこの方法では読めない。秘匿値は Secrets Manager などに置き、動的参照で読む（このデモには秘匿値が無い。06「[データ保護](../06-security-specification.md#データ保護)」） |

## 参考資料

- [Choosing parameter tiers in Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-advanced-parameters.html)（標準とアドバンスト）
- [Specify existing resources at runtime with CloudFormation-supplied parameter types](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-supplied-parameter-types.html)（SSM パラメータ型・値を読む時点・`SecureString` は使えない）
