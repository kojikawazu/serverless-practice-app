# Terraform 解説

Terraform とは何か、どう動くか、このプロジェクトでなぜ・どう使うかを、このデモで Terraform に置いている土台を例にまとめる。このプロジェクト固有の決定（Terraform と CDK の分担・state の置き場所・デプロイの順序・認証）は [09 アーキテクチャ仕様書](../09-architecture-specification.md#iac-の責務分担)が正本で、state の運用ルールの正本は [`.claude/rules/iac.md`](../../.claude/rules/iac.md)。本書はそれらを参照し、本文を複製しない。LocalStack へ向ける道具（`tflocal`）は [LocalStack 解説](localstack.md#関連する道具)を前提にする。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-10-18 に確認）、このプロジェクトで確かめたことは 09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [Terraform とは](#terraform-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## Terraform とは

インフラの「あるべき姿」をファイル（HCL という設定言語の `.tf`）に書き、今の実物との差分を計算して、その差分だけを作る・変える・消すツール。手順（何をどの順に呼ぶか）ではなく結果（何があるべきか）を書くので、**宣言的**と呼ばれる。

AWS などの各サービスとのやり取りは**プロバイダ**（AWS なら `hashicorp/aws`）が受け持ち、Terraform 本体はどのクラウドでも同じ流れで動く。

| 用語 | 意味 |
|---|---|
| リソース | 作りたいもの 1 つ（`resource "aws_sqs_queue" "mail" { ... }`） |
| データソース | 作らずに読むだけのもの（`data "aws_caller_identity" "current" {}`） |
| プロバイダ | サービスの API を呼ぶプラグイン。版を固定して使う |
| state | 定義のリソースと、実物（キューの URL・ARN など）の対応表 |
| backend | state を置く場所（ローカルのファイル・S3 など） |

## 仕組み

### plan と apply と state

```text
.tf（あるべき姿） ─┐
                   ├─ plan ─▶ 差分（作る / 変える / 消す） ─ apply ─▶ 実物に反映 ─▶ state を更新
state（前回の対応表）┘     ▲
                          └ refresh: state にある実物の今の姿を API で読み直す
```

`plan` は、state にある実物の今の姿を読み直し、定義と比べて差分を出す（公式「terraform plan」）。`apply` はその差分を実物に反映し、state を書き換える。`plan` に `-detailed-exitcode` を付けると、差分が無ければ 0、差分があれば 2、エラーなら 1 で終わる（公式）ので、「定義と実物がずれていないか」を検査に使える。

**state が「どの実物がどのリソースか」を覚えている唯一の場所**（公式「State」）。state を失うと、Terraform は実物を見失い、`apply` で同じものをもう一度作ろうとする（重複・名前の衝突）。実物を 1 つずつ `import` し直すまで戻らない（[`iac.md`](../../.claude/rules/iac.md)）。state には変数の値や属性が平文で入るため、秘匿値を含みうる（公式）。

### backend とロック

state はリモートの backend に置くよう公式は勧めている（公式「State」）。S3 の backend では次のことができる（公式「Backend Type: s3」）。

| 機能 | 内容 |
|---|---|
| ロック | `use_lockfile = true` で、state の隣にロック用のオブジェクトを置き、同時の `apply` を止める。既定は無効（オプトイン）。以前の DynamoDB によるロックは非推奨で、将来の版で取り除かれる |
| 暗号化 | `encrypt = true` で、state とロックのファイルをサーバー側で暗号化する |
| 復旧 | 公式は state のバケットのバージョニングを強く勧めている。誤って消した・壊したときに戻せるように |
| 部分的な設定 | backend の値の一部を `.tf` に書かず、`init -backend-config=<ファイル>` で渡せる。ただし渡した値は `.terraform` の中と plan のファイルに残る |

`init` は backend とプロバイダを準備するコマンドで、backend を変えたときは `-reconfigure`（既存の設定を無視し、state を移さない）で設定し直す（公式「terraform init」）。

### 依存と順序

Terraform は、あるリソースが別のリソースの値を参照していれば（例: `aws_sqs_queue.mail_dlq.arn`）、参照先を先に作る。参照が無いのに順序が要る「隠れた依存」には `depends_on` を書く（公式「depends_on」）。

公式は `depends_on` を**最後の手段**としている。plan が保守的になり、必要以上の置き換えや、apply まで値が分からない状態を生むため。値を参照できるなら参照で依存を表すほうがよい。

依存は作る順序だけでなく、**消す順序**も決める。Terraform は依存の逆順に消す（公式の `depends_on` のページは削除の順序に触れていない。このプロジェクトでは #71 の `dev` で、依存させたロググループがキャパシティプロバイダの削除の後に消えたことを確かめた。09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」の「LMI」）。

依存は `terraform graph` で見られる。`-type` を付けなければ設定から依存を描き、`-type=plan-destroy` は state にあるものを消す操作のグラフを描く（教訓ログ「[terraform graph -type=plan-destroy が state の無い環境で空のグラフを返し、順序の検査が空振りしかけた](../lessons-learned.md#2026-10-17-terraform-graph--typeplan-destroy-が-state-の無い環境で空のグラフを返し順序の検査が空振りしかけた)」）。

### count と for_each

1 つの `resource` ブロックから複数の実物を作る仕組み（公式「count」「for_each」）。

| | `count` | `for_each` |
|---|---|---|
| 渡すもの | 数 | マップか集合 |
| 実物の住所 | 番号（`aws_subnet.lmi[0]`・`[1]`） | キー（`aws_iam_role.lambda["enqueue"]`） |
| 向いているもの | ほぼ同じものを n 個。**`0 か 1` で作る・作らないを切り替える** | 1 つずつ値が違うもの |

`count` を条件に使う（`count = 条件 ? 1 : 0`）と、作らないときは実物が 0 個になる。その代わり、作るときも参照は `[0]` を付けて書く。`count` と `for_each` は同じブロックに同時に書けない（公式）。

### プロバイダの版とロックファイル

`required_providers` の版の制約（例: `~> 6.68`）は「使ってよい範囲」で、実際に選んだ版とそのハッシュは `.terraform.lock.hcl` に記録される（公式「Dependency Lock File」）。公式はこのファイルをバージョン管理に入れるよう勧めている。`init -lockfile=readonly` は、ロックファイルを書き換えず、記録済みのハッシュとの照合だけを行う（公式「terraform init」）。

### 検査のコマンド

| コマンド | 確かめること | 確かめないこと |
|---|---|---|
| `terraform fmt -check` | 整形の差分が無い | 中身の正しさ |
| `terraform validate` | 構文・参照・型の整合（変数や state に依らない） | **リモートのもの（state・プロバイダの API）** には触れない（公式） |
| `terraform plan` | 定義と実物の差分 | — （実物と state が要る） |

`validate` は初期化済みの作業ディレクトリを要るが、backend に触れずに初期化するなら `init -backend=false` を使う（公式「terraform validate」）。

## このプロジェクトで使う理由

元資料の構成では、変わりにくい土台を Terraform、アプリを CDK が持ち、別のリポジトリになっている。このデモはそれを 1 リポジトリの 2 ディレクトリで再現する（09「[ディレクトリ構成](../09-architecture-specification.md#ディレクトリ構成)」）。

| 使っているもの | このプロジェクトでの使い方 | 正本 |
|---|---|---|
| Terraform に置くもの | IAM ロール（Lambda 4 種・Step Functions・Scheduler）・SQS FIFO と DLQ・S3・Schedule group・SSM パラメータ。`dev` だけ LMI の VPC・キャパシティプロバイダとそのロール・ロググループ | 09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」・「[IaC の責務](../09-architecture-specification.md#iac-の責務)」 |
| CDK への受け渡し | Terraform が作った ARN・名前・URL・Consumer のタイムアウトを、SSM パラメータ（`/serverless-practice-app/<stage>/...`）に書き出す。`for_each` で 1 つのマップから作る | 05「[SSM パラメータ](../05-data-specification.md#ssm-パラメータ)」 |
| 名前の先決め | CDK が後から作る関数・ステートマシンの名前を `serverless-practice-app-<stage>-<name>` に固定し、Terraform の IAM ポリシーはその名前で権限を付ける | 09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」 |
| 版 | Terraform `~> 1.14.0`・AWS プロバイダ `~> 6.68`。ロックファイルはコミットする | 09「[技術スタック](../09-architecture-specification.md#技術スタック)」 |
| backend | S3 の 1 種類。バケットは `dev` 用に専用で 1 つ、`key` をステージで分ける。ロックは `use_lockfile`（DynamoDB は使わない） | 09「[Terraform の state](../09-architecture-specification.md#terraform-の-state)」 |
| 変数 | `envs/<stage>.tfvars`（秘匿値を置かない前提でコミットする）と `envs/<stage>.s3.tfbackend`（state の `key`） | 09「[Terraform の state](../09-architecture-specification.md#terraform-の-state)」 |
| ステージで変わるリソース | LMI の部分を `count = local.lmi_enabled ? 1 : 0`（`stage == "dev"`）で `dev` だけ作る | 09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」 |
| 操作の入口 | `scripts/terraform.sh <stage> <command>`（`init` / `plan` / `apply` / `destroy`）。`local` は `tflocal`、`dev` は `terraform` を使い、`init` は毎回 `-reconfigure` で backend を設定し直す。作る・消すは `scripts/stack.sh` が Terraform → CDK（消すときは逆）の順に呼ぶ | 09「[順序](../09-architecture-specification.md#順序)」・「[手順（ステージ `local`）](../09-architecture-specification.md#手順ステージ-local)」 |
| 検査 | `scripts/lint-terraform.sh`（`fmt -check`・`init -backend=false -lockfile=readonly`・`validate`）を手元と CI の `terraform` ジョブで実行する。`local` への `apply` は CI の `it` ジョブがデプロイの中で行う | 09「[CI とマージの条件](../09-architecture-specification.md#ci-とマージの条件)」 |

## 特徴と制約

### state のバケットは Terraform で作らない

state を置くバケットを Terraform で作ろうとすると、そのバケットを作った記録（state）をどこに置くかが決まらない（鶏と卵）。このプロジェクトは、バケットを冪等なスクリプト `scripts/tfstate-bucket.sh dev` で作り、バージョニング・公開の禁止・HTTPS 以外の拒否・古い版の削除などを、項目ごとに比べてずれている分だけ直す（09「[Terraform の state](../09-architecture-specification.md#terraform-の-state)」・[`iac.md`](../../.claude/rules/iac.md)）。バケット名とリージョンは `versions.tf` の backend から読み、書き写さない。

作った直後のバケットは、実 AWS では存在の確認（`head-bucket`）に 404 を返すことがあり、スクリプトが作り直しに進んで失敗した。LocalStack では起きなかった（教訓ログ「[作成直後の S3 バケットが head-bucket に 404 を返し、state バケットの作成スクリプトが自分のバケットの作り直しで失敗した](../lessons-learned.md#2026-10-11-作成直後の-s3-バケットが-head-bucket-に-404-を返しstate-バケットの作成スクリプトが自分のバケットの作り直しで失敗した)」）。

`iac.md` は「共有のバケットを prefix で分ける」を基本にしているが、このプロジェクトは専用のバケットにした。その理由（共有のバケットがまだ無い・prefix は権限の境界にならない）も 09 にある。

### Terraform 1.14 は `aws login` のプロファイルを読めない

`dev` の認証は `aws login` のプロファイルで行う。AWS CLI と CDK はそのまま読めるが、Terraform 1.14.3（AWS プロバイダ 6.68.0）は読めず、`No valid credential sources found` で止まった（2026-10-11）。`scripts/terraform.sh` が `dev` のときだけ、`aws configure export-credentials` で一時的な認証情報に変換し、環境変数でそのプロセスにだけ渡す（09「[ステージ](../09-architecture-specification.md#ステージ)」・教訓ログ「[Terraform 1.14 が aws login のプロファイルを読めず、dev へ plan できなかった](../lessons-learned.md#2026-10-11-terraform-114-が-aws-login-のプロファイルを読めずdev-へ-plan-できなかった)」）。

変換の結果は、代入と `eval` を分けて終了コードを見ている。`eval "$(...)"` の形では、変換の失敗が `eval` の成功で上書きされ、認証情報の無いまま先へ進むため。

### `depends_on` で、作る順序と消す順序を同時に決めた

LMI のキャパシティプロバイダは、2 つに `depends_on` で依存している（`lmi.tf`）。

| 依存先 | 作るとき | 消すとき |
|---|---|---|
| オペレーターのロールへのポリシーの付与 | ポリシーが付く前にプロバイダを作ると、Lambda が EC2 を操作できずに作成が失敗しうる | — |
| プロバイダのロググループ | 先に作り、LMI がそこへ書く | **プロバイダの削除が終わってから消す**。最後のインスタンスは、プロバイダの削除をきっかけに終わることがあり、並行して消すと終了のログで LMI がロググループを作り直しうる（並行して消す構成は試していない） |

どちらもプロバイダの設定から値を参照しない「隠れた依存」で、公式が `depends_on` を使う場面に当たる。消す順序は #71 の `dev` で確かめ、`terraform graph` の辺が `depends_on` から外すと消えることも確かめた（09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」・「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」の「LMI」）。

### `count` の条件は、CDK と 2 か所にある

LMI を `dev` だけで作る条件は、Terraform（`lmi.tf` の `stage == "dev"`）と CDK（`LMI_STAGES`）の両方にある。SSM の `capacity-provider/arn` も、同じ条件のときだけ書き出す。CDK の UT は、`local` では紐付けず、`dev` ではデータ連携 Lambda だけを SSM の `capacity-provider/arn` で紐付けることを固定している（09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」）。UT が固定しているのは CDK 側の条件だけで、Terraform 側の条件と突き合わせる検査は無い（`infra/cdk/test/batch-stack.test.ts` で確認）。食い違ったときに何が起きるかは試していない。

### 定義と実物のずれを、定期的には確かめていない

`iac.md` は `plan` の差分が空であることを定期的に確かめるよう求めている。このプロジェクトの検査（`lint-terraform.sh`）は `validate` までで、`plan` は実行しない。`validate` は state にもプロバイダの API にも触れないため、実物とのずれは見えない（上記）。

`dev` は検証のたびに作って消しているため、ずれが溜まる期間は短い。ただし検証の中では、AWS CLI で設定を一時的に書き換えている（定時の Schedule の式・関数の環境変数など。09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）。これは CDK 側のリソースが多いが、検証の後に元に戻すか、スタックごと消して戻している。消さずに残すことになったら、`plan -detailed-exitcode`（`scripts/terraform.sh dev plan -detailed-exitcode`）で差分が 0 であることを確かめる必要がある。

### Terraform では、Lambda のタイムアウトを 900 秒より長くできない

LMI のデータ連携 Lambda のタイムアウト（1,800 秒）は、Terraform では設定できず、関数ごと CDK が持つ（09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」）。どのツールに何を置くかは、責務の分担だけでなく、ツールが対応している範囲でも決まる。

## LocalStack との違い

| 違い | 正本 |
|---|---|
| `local` では `tflocal` を使う。プロバイダと backend の接続先を LocalStack に差し替える上書きファイル（`localstack_providers_override.tf`、Git 管理外）を作業ディレクトリに書き出し、実行の後で消す（v0.26.0 のコードで確認）。そのため `scripts/terraform.sh` は `-chdir` ではなくディレクトリに移って実行する | 09「[Terraform の state](../09-architecture-specification.md#terraform-の-state)」・[LocalStack 解説](localstack.md#関連する道具) |
| `local` の state は LocalStack 内の S3 に置かれ、バケットは `tflocal` が自動で作る。LocalStack の再起動でリソースごと消えるため、state も使い捨てでよい | 09「[Terraform の state](../09-architecture-specification.md#terraform-の-state)」 |
| LMI の API が Hobby プランで使えないため、LMI の部分は `local` では作らない | 09「[IaC の責務](../09-architecture-specification.md#iac-の責務)」 |
| LocalStack は既定で IAM のポリシーを評価しないため、Terraform が作ったロールの権限が足りなくても `local` では動く | 06「[認可](../06-security-specification.md#認可権限制御)」 |
| state バケットの作成直後の 404 は、LocalStack では起きない（上記） | 教訓ログ（上記） |

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| `apply` が「既にある」で失敗する・同じものを作ろうとする | state を見失っている（別の `key`・別のバケット・ローカルの state）。state を失ったまま `apply` せず、正しい backend で `init` し直すか、`import` で戻す |
| 別のステージの state を操作してしまう | backend の `key` が前の `init` のまま残っている。`init -reconfigure -backend-config=envs/<stage>.s3.tfbackend` で毎回設定し直す（`scripts/terraform.sh` はそうしている） |
| `dev` で `No valid credential sources found` | `aws login` のプロファイルを Terraform が読めない。`scripts/terraform.sh` から実行する |
| `validate` は通るのに `apply` が失敗する | `validate` はプロバイダの API に触れない。名前の重複・権限・サービスの制約は `plan` / `apply` まで分からない |
| CI の `init` がロックファイルのエラーで落ちる | ロックファイルに無い版・ハッシュを要求している。手元で `terraform init -upgrade` などでロックファイルを更新し、コミットする |
| 条件付きのリソースを参照するとエラーになる | `count` で作ったリソースは `[0]` を付けて参照する。作らない条件のときは参照する側も同じ条件で囲む |
| 消す順序が思った順にならない | 値の参照が無い依存は Terraform に見えない。`depends_on` で書き、`terraform graph`（`-type` なし）で辺を確かめる |
| `terraform graph -type=plan-destroy` が空になる | state の無い環境では、消すものが無く空のグラフになる。設定の依存は `-type` なしで見る |
| `tflocal` が `Providers override file ... already exists` で止まる | 前回の `tflocal` が書き出した `localstack_providers_override.tf` が残っている。`tflocal`（v0.26.0）は実行の後で消すが、強制終了などで残りうる。消してから実行し直す。残ったまま手で `terraform` を実行すると、`*_override.tf` も読み込まれるため、接続先が LocalStack になるはず（試していない） |

## 参考資料

- [Terraform Language Documentation](https://developer.hashicorp.com/terraform/language)
- [State](https://developer.hashicorp.com/terraform/language/state)（state の役割・秘匿値・リモートの backend）
- [Backend Type: s3](https://developer.hashicorp.com/terraform/language/backend/s3)（`use_lockfile`・DynamoDB のロックの非推奨・バージョニング・部分的な設定）
- [The depends_on Meta-Argument](https://developer.hashicorp.com/terraform/language/meta-arguments/depends_on)（隠れた依存・最後の手段）
- [The count Meta-Argument](https://developer.hashicorp.com/terraform/language/meta-arguments/count)・[The for_each Meta-Argument](https://developer.hashicorp.com/terraform/language/meta-arguments/for_each)
- [Dependency Lock File](https://developer.hashicorp.com/terraform/language/files/dependency-lock)
- [terraform init](https://developer.hashicorp.com/terraform/cli/commands/init)（`-backend=false`・`-lockfile=readonly`・`-reconfigure`・`-backend-config`）
- [terraform validate](https://developer.hashicorp.com/terraform/cli/commands/validate)（リモートに触れないこと）
- [terraform plan](https://developer.hashicorp.com/terraform/cli/commands/plan)（refresh・`-detailed-exitcode`）
- [terraform graph](https://developer.hashicorp.com/terraform/cli/commands/graph)
