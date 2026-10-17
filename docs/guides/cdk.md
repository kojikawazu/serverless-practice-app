# CDK 解説

AWS CDK とは何か、どう動くか、このプロジェクトでなぜ・どう使うかを、このデモのアプリ側（`infra/cdk`）を例にまとめる。このプロジェクト固有の決定（Terraform と CDK の分担・受け渡しの方法・デプロイの順序）は [09 アーキテクチャ仕様書](../09-architecture-specification.md#iac-の責務分担)が正本で、スタックの実体は `infra/cdk/lib/batch-stack.ts`。本書はそれらを参照し、本文を複製しない。土台を作る Terraform は [Terraform 解説](terraform.md)、LocalStack へ向ける道具（`cdklocal`）は [LocalStack 解説](localstack.md#関連する道具)を前提にする。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-10-18 に確認）、このプロジェクトで確かめたことは 09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [CDK とは](#cdk-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## CDK とは

AWS のリソースを、プログラミング言語（このプロジェクトは TypeScript）のコードで組み立てるためのフレームワーク。コードは CloudFormation のテンプレートに変換され、デプロイは CloudFormation を通して行われる（公式「What is the AWS CDK?」）。

Terraform が「あるべき姿を HCL で宣言する」道具だったのに対し、CDK は「コードで組み立て、その結果をテンプレートにする」道具になる。公式は、条件分岐・ループ・合成（composition）といった言語の機能や、コードレビュー・ユニットテストといった開発の作法を、インフラの定義に使えることを利点に挙げている（同）。

| 用語 | 意味 |
|---|---|
| synth | コードを CloudFormation のテンプレートに変換する（`cdk synth`）。出力先は `cdk.out/` |
| deploy | テンプレートを CloudFormation に渡し、スタックを作る・更新する（`cdk deploy`） |
| スタック | デプロイの単位。1 つの CloudFormation スタックに対応する |
| コンストラクト | リソースを表すクラス。レベル（L1・L2・L3）で抽象化の度合いが違う |
| bootstrap | CDK がデプロイに使う作業用リソース（S3・ECR・IAM ロール）を、環境に 1 回作る |
| context | `-c key=value` や `cdk.json` で渡す値。このプロジェクトはステージ（`stage`）を渡す |

## 仕組み

```text
infra/cdk/bin/app.ts（コード）
  └ synth ─▶ CloudFormation テンプレート（cdk.out/）
              └ deploy ─▶ CloudFormation がスタックを作る・更新 ─▶ AWS のリソース

Lambda のコード: NodejsFunction が synth の中で esbuild によりバンドルし、アセットとして置く
```

`cdk.json` の `app` が `npx tsx infra/cdk/bin/app.ts` を指すため、TypeScript を事前にビルドせず、`tsx` で直接実行する（[`cdk.json`](../../cdk.json)）。

### L1 と L2 のコンストラクト

公式によると、L1 は CloudFormation のリソースと 1 対 1 に対応し、抽象化がない。L2 は既定値・補助メソッド（権限の付与の `grant*` など）を持つ。L3 は複数のリソースをまとめたパターン（公式「Constructs」）。

このプロジェクトでは、ほとんどが L2（`nodejs.NodejsFunction`・`sfn.StateMachine`・`events.Rule`・`logs.LogGroup`）で、L1 を使うのは 2 か所だけ（`batch-stack.ts`）。

- 定時の Schedule（`scheduler.CfnSchedule`）: L1 で書き、`RetryPolicy` を指定していない。実際に何回再試行されるかは未確認で、[#92](https://github.com/kojikawazu/serverless-practice-app/issues/92) で `get-schedule` を読んで確かめる
- LMI の関数の紐付け（`lambda.CfnFunction`）: L2 の `NodejsFunction` が持つ L1 の子（`node.defaultChild`）を取り出し、キャパシティプロバイダの設定を直接書く。キャパシティプロバイダは Terraform が作ったものを読み込んで使う（`ICapacityProvider`）が、読み込んだものには関数を足す `addFunction` が無いため

### 別のスタック（Terraform）の値を SSM から読む

Terraform の土台が作った ARN・名前・URL は、SSM パラメータ（`/serverless-practice-app/<stage>/...`）に書き出されている（[05「SSM パラメータ」](../05-data-specification.md#ssm-パラメータ)）。CDK はそれを `ssm.StringParameter.valueForStringParameter` で読む。

公式によると、この関数は合成の時点では値を読まず、**デプロイの時点で解決される**トークンを返す（公式「StringParameter」）。このため、合成したテンプレートには値ではなく SSM の名前が残る。このプロジェクトのテストが、合成したテンプレートの `Parameters` の `Default` を読んで SSM の名前を確かめているのは、この仕組みによる。

Consumer のタイムアウトは `Token.asNumber` で数値として渡す。値の正本は Terraform にあり、CDK は値を持たない（04 の「連動するパラメータ」）。

## このプロジェクトで使う理由

| 分担 | 中身 | 正本 |
|---|---|---|
| CDK が持つもの | Lambda 4 種（`NodejsFunction`）・Step Functions（`sfn.StateMachine`、JSONata）・定時の Schedule（`CfnSchedule`）・失敗通知の EventBridge rule・LMI への関数の紐付け | 09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」 |
| CDK が持つもの（ロググループ） | Lambda のロググループ。Terraform のポリシーが書き込みを許す名前（`/aws/lambda/<関数名>`）で作り、7 日保持し、スタックの削除で一緒に消す | 04「[保持期間](../04-non-functional-specification.md#保持期間)」 |
| Terraform から受け取るもの | IAM ロール・SQS・S3・Schedule group・LMI のキャパシティプロバイダの ARN。SSM パラメータ経由 | 05「[SSM パラメータ](../05-data-specification.md#ssm-パラメータ)」 |
| 権限の扱い | IAM ロールは `fromRoleArn` で `mutable: false` の参照にする。CDK の `grant*` が権限を足そうとしても何も起きず、ポリシーは Terraform だけが持つ | 09「IaC の責務分担」 |
| 名前の先決め | 関数・ステートマシンは `serverless-practice-app-<stage>-<name>` の名前にする。Terraform の IAM はその名前で権限を付ける | 09「IaC の責務分担」 |
| ステージ | `-c stage=local` または `-c stage=dev` を必ず渡す。未指定や別の値は、既定値に倒さずエラーにする（`lib/stage.ts` の `parseStage`） | 09「[ステージ](../09-architecture-specification.md#ステージ)」 |
| 操作の入口 | `scripts/cdk.sh <stage> bootstrap` / `deploy` / `destroy`。土台とあわせた順序は `scripts/stack.sh` が決める | 09「[デプロイ](../09-architecture-specification.md#デプロイ)」 |

### 権限を CDK に持たせない理由

Lambda や Step Functions の L2 は、呼び出し先の権限を `grant*` で足す。このデモでは、足されると IAM の設定が 2 か所（Terraform と CDK）に分かれ、どちらが正かが分からなくなる。そこで、ロールは `mutable: false` で参照し、スタックが IAM のロール・ポリシーを 1 つも作らないことを UT で固定している（`batch-stack.test.ts`）。

### 作る順と消す順を、1 本のスクリプトに固定する理由

CDK のスタックは、Terraform が作ったロール・キューを参照している。そのため Terraform → CDK の順に作り、CDK → Terraform の順に消す。逆にすると、CDK のスタックが参照中のロールやキューが先に消える（09「[順序](../09-architecture-specification.md#順序)」）。

手で 2 つのコマンドを打つと、順序を間違えうる。`scripts/stack.sh <stage> up` / `down` がこの順序で `terraform.sh` と `cdk.sh` を呼ぶので、順序はこの 1 本にしか書かれていない。

## 特徴と制約

### bootstrap は、デプロイの前に 1 回だけ作る

公式によると、bootstrap は CDK の作業用リソース（アセットを置く S3 バケット・コンテナイメージの ECR・デプロイ用の IAM ロール）を作る。既定のスタック名は `CDKToolkit`（公式「Bootstrapping」）。

このプロジェクトでは `scripts/stack.sh <stage> up` が、Terraform の適用のあと、デプロイの前に毎回 `cdk.sh bootstrap` を呼ぶ。`CDKToolkit` が残っていれば何もせずに終わり、消えていれば作り直すため、どちらでも手順は変わらない（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）。

`cdk destroy` では `CDKToolkit` は消えない。このプロジェクトは消さずに残すと決めた（2026-10-13。#47）。作業用リソースはアカウント・リージョンに 1 つで、検証用アカウントを他のプロジェクトと共用しているため、消すと後から同じアカウントで CDK を使うプロジェクトのデプロイを壊しうる。費用もアセット用の S3 バケットの保管料だけで小さい。理由と、消すことになったときの手順の正本は 09「`dev` での検証結果」。

### 既定値に頼ると、テンプレートに値が出ない

指定を省いた設定は、合成したテンプレートに値として現れないことがある。このデモでは、ステートマシンの種類（Standard か Express か）を CDK で指定しておらず、CDK の既定（`STANDARD`）に頼っている。合成したテンプレートにも `StateMachineType` は出ない（09「[Step Functions の流れ](../09-architecture-specification.md#step-functions-の流れ)」）。

テンプレートに値が無いので、UT もその値を固定できていない。`.waitForTaskToken` は Standard でしか使えないため、Express に変わると `DataSync` が壊れるのに、検査では落ちない。CDK で明示して UT で固定する対応は [#90](https://github.com/kojikawazu/serverless-practice-app/issues/90) で扱う。

### 検査は、合成したテンプレートに対するユニットテスト

テストは vitest で書き、`aws-cdk-lib/assertions` の `Template.fromStack` で合成結果を読む（`infra/cdk/test/batch-stack.test.ts`）。確かめるのは「CDK が作るテンプレートの形」で、タイムアウトの値・Retry の対象・IAM を作らないこと・ロググループの保持期間などを固定している。

テンプレートの検査は、実 AWS の振る舞いを確かめない。分かるのは「その設定がテンプレートに書かれていること」までで、「その設定が実際に効くこと」は分からない。LMI の例では、UT・LocalStack の IT・`dev` の手動検証で、それぞれ何を確かめるかを分けている（09「[テスト](../09-architecture-specification.md#テスト)」）。

実際に、設定を足して UT で固定しても、その設定が効く呼び出し方になっていなかったことがある。データ連携 Lambda の非同期の再試行 0 を `$LATEST.PUBLISHED` に足したが、修飾子なしの呼び出しには元から `$LATEST` の設定が効いており、足した設定は効いていなかった。`dev` で対照を取って分かり、実装と UT を戻した（#70。教訓ログ「[LMI の非同期の再試行設定を「付いている版」から推論し、効いていないと誤認した](../lessons-learned.md#2026-10-17-lmi-の非同期の再試行設定を付いている版から推論し効いていないと誤認した)」）。

### 合成のたびに Lambda をバンドルする

`NodejsFunction` は synth の中で esbuild を走らせる。そのためテストは、スタックの合成をステージごとに 1 回だけ行い、各テストで結果を共有する（`batch-stack.test.ts` の `synth`）。

## LocalStack との違い

| 違い | 正本 |
|---|---|
| `local` では `cdklocal`（`aws-cdk-local`）を使い、接続先を LocalStack に差し替える。`scripts/cdk.sh` がステージで選ぶ | 09「[前提ツール](../09-architecture-specification.md#前提ツール)」・`scripts/cdk.sh` |
| LMI への紐付けは `dev` だけ（`LMI_STAGES`）。LocalStack の Hobby プランでは LMI の API を使えなかったため | 09「[LMI](../09-architecture-specification.md#lmilambda-managed-instances)」 |
| データ連携 Lambda のタイムアウトは `local` が 900 秒、`dev` が 1,800 秒。LMI を使わない関数は 900 秒を超えられない | 09「[実装で設計から変えた点](../09-architecture-specification.md#実装で設計から変えた点)」 |
| `local` の `stack.sh` は確認を省く（`--require-approval never`・`--force`）。`dev` は確認を残す。実 AWS のリソースを、確認なしで作ったり消したりしないため | `scripts/stack.sh` |

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| `ステージを -c stage=local\|dev で指定してください` と出る | 仕様どおり。既定値に倒すと、違うステージへデプロイしかねないため。`scripts/cdk.sh` を通す |
| `cdk destroy` のあとも `CDKToolkit` が残る | 仕様どおり（上記）。消すのは CDK のスタックと Terraform の土台だけ |
| `deploy` が、SSM パラメータが無いことで失敗する（公式の仕組みからの推論。試していない） | 値はデプロイの時点で解決されるため、Terraform を先に適用していないと SSM が無い。順序は `scripts/stack.sh`（Terraform → CDK）に固定している |
| テンプレートに、あるはずの設定（`StateMachineType` など）が見当たらない | CDK で指定せず、既定に頼っている。既定に頼った値は UT でも固定できないため、意味のある設定は明示して UT で固定する（上記） |
| LMI の紐付けの条件が 2 か所にある | Terraform（`lmi.tf` の `stage == "dev"`）と CDK（`LMI_STAGES`）の両方で同じ条件にしている。突き合わせる検査は無い（[Terraform 解説](terraform.md#特徴と制約)） |
| 固定した値を変えたら UT が落ちる | UT は仕様の値を固定している。値を変えるときは仕様（09・04）と一緒に直し、テストも更新する |
| `synth` が遅い | `NodejsFunction` のバンドルが走るため。テストはステージごとに 1 回だけ合成する |

## 参考資料

- [What is the AWS CDK?](https://docs.aws.amazon.com/cdk/v2/guide/home.html)（CloudFormation との関係・利点）
- [AWS CDK Developer Guide: Constructs](https://docs.aws.amazon.com/cdk/v2/guide/constructs.html)（L1・L2・L3 の定義）
- [AWS CDK Developer Guide: Bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)（`CDKToolkit` と作業用リソース）
- [aws-cdk-lib.aws_ssm.StringParameter](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ssm.StringParameter.html)（`valueForStringParameter` はデプロイ時に解決される）
- [aws-cdk-lib/assertions](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.assertions-readme.html)（テンプレートのユニットテスト）
