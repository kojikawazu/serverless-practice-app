# IAM 解説

AWS IAM（Identity and Access Management）とは何か、AWS のサービスどうしの呼び出しがどう許可されるか、このプロジェクトでなぜ・どう使うかをまとめる。このプロジェクト固有の決定（ロールごとの許可する操作と対象）は [06 セキュリティ仕様書](../06-security-specification.md#認可権限制御)が正本で、ロールとポリシーの実体は `infra/terraform/iam.tf`（LMI のオペレーターは `lmi.tf`）。本書はそれらを参照し、本文を複製しない。

公式ドキュメントの記述は「公式」と書いて出典を添え（2026-11-08 に確認）、このプロジェクトで確かめたことは 09・[教訓ログ](../lessons-learned.md)を参照する。

## 目次

- [IAM とは](#iam-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [特徴と制約](#特徴と制約)
- [LocalStack との違い](#localstack-との違い)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## IAM とは

AWS への呼び出し（API リクエスト）を、**誰が・何を・どれに対して**してよいかで判定する仕組み。人がコンソールや CLI で操作するときも、Lambda が SQS にメッセージを送るときも、同じ判定を通る。

サーバーを持たない構成では、サービスどうしの呼び出しがすべて IAM を通る。Scheduler がステートマシンを起動する、ステートマシンが Lambda を呼ぶ、Lambda が S3 に書く、のそれぞれに許可が要る。**どれか 1 つが欠けると、その段だけが `AccessDenied` で止まる。**

## 仕組み

### 誰が・何を・どれに

ポリシーは、次の要素の組（ステートメント）を並べた JSON。

| 要素 | 意味 | 例 |
|---|---|---|
| `Principal` | 誰が（リソースベースのポリシーにだけ書く） | `events.amazonaws.com`（EventBridge のサービス） |
| `Action` | 何を | `sqs:SendMessage`・`lambda:InvokeFunction` |
| `Resource` | どれに（ARN） | `arn:aws:sqs:<region>:<account>:<queue>` |
| `Effect` | 許可か拒否か | `Allow` / `Deny` |
| `Condition` | どんな条件のときか（任意） | `aws:SourceAccount` が自分のアカウントのとき |

### ロールと信頼ポリシー

**ロール**は、権限の入れ物。人やサービスがロールを**引き受けて**（`sts:AssumeRole`）、一時的な認証情報でその権限を使う。長期のアクセスキーを持たせずに済む。

ロールには 2 種類のポリシーが付く。

| ポリシー | 決めること |
|---|---|
| 信頼ポリシー | **誰が**このロールを引き受けてよいか。サービスに使わせるなら、サービスのプリンシパル（`lambda.amazonaws.com`・`states.amazonaws.com`・`scheduler.amazonaws.com`）を書く |
| 許可ポリシー | 引き受けた者が**何をしてよいか** |

Lambda は、関数を呼ばれたときに自動で実行ロールを引き受ける。そのため、信頼ポリシーに Lambda のサービスプリンシパルが入っている必要がある（公式「Defining Lambda Event Function permissions with an execution role」）。Step Functions のステートマシンのロール、Scheduler の実行ロールも同じ形で、それぞれのサービスが引き受ける。

### ID ベースのポリシーとリソースベースのポリシー

許可の書き方は 2 通りある。

| 種類 | どこに付くか | 書き方 | このプロジェクトの例 |
|---|---|---|---|
| ID ベース | ロール（呼ぶ側） | 「このロールは X に Y をしてよい」 | 投入 Lambda のロールに `sqs:SendMessage` |
| リソースベース | リソース（呼ばれる側） | 「Z（`Principal`）は自分に Y をしてよい」 | Slack 通知 Lambda に「EventBridge は呼んでよい」 |

**同じアカウントの中では、どちらか一方が許可していれば通る**（公式「Policy evaluation for requests within a single account」）。EventBridge のルールから Lambda を呼ぶときは、ルールにロールを持たせず、関数側のリソースベースのポリシーで許可するのが基本の形（[EventBridge 解説](eventbridge.md#ルールのターゲットへの配信と再試行)）。

### 評価の順序

リクエストが来ると、AWS は関係するすべてのポリシーを集めて、次の順に判定する（公式「Policy evaluation for requests within a single account」）。

1. **明示の拒否**（`Deny`）がどれかにあれば、拒否。許可より強い
2. 許可（`Allow`）がどれかにあれば、許可
3. どちらも無ければ、拒否（**暗黙の拒否**。何も書かなければ何もできない）

このため、「全部を拒否して、必要なものだけ許可する」書き方はできない。許可は足し算で、拒否は許可を打ち消す。このプロジェクトで明示の拒否を使うのは、データ連携の出力先バケットのポリシーだけで、HTTPS でない（`aws:SecureTransport` が `false` の）リクエストをすべて拒否する（`s3.tf`。公式「Security best practices for Amazon S3」が勧める形）。

### 混乱した代理と条件キー

サービスのプリンシパル（例: `scheduler.amazonaws.com`）を信頼すると、**そのサービスを使う誰もが**、そのサービス経由で自分のリソースに触れうる。権限の無い者が、権限を持つサービスを「代理」として操る問題を、**混乱した代理（confused deputy）**と呼ぶ（公式「The confused deputy problem」）。

公式は、サービスのプリンシパルに権限を渡すときは、次の条件キーで「誰の代わりに動いているか」を絞るよう勧めている。

| 条件キー | 絞るもの |
|---|---|
| `aws:SourceAccount` | 代わりに動いている元のアカウント |
| `aws:SourceArn` | 代わりに動いている元のリソース（特定のルール・特定のスケジュールなど） |

条件キーに対応しているかはサービスごとに違い、公式は各サービスのドキュメントで確かめるよう書いている（同じページ）。

### Lambda の ARN と修飾子

Lambda の関数の ARN には、修飾子（版・エイリアス）の付かない形と付く形がある（[Lambda 解説](lambda.md#版と修飾子)）。`lambda:InvokeFunction` の許可は、**リクエストが指した ARN の形とポリシーの `Resource` の形が合わないと拒否される**（公式「Fine-tuning the Resources and Conditions sections of policies」）。

| ポリシーの `Resource` | 通る呼び出し |
|---|---|
| `…:function:my-function` | 修飾子なしだけ |
| `…:function:my-function:1` | その版だけ |
| `…:function:my-function:*` | 修飾子付き（どの版・エイリアスでも）だけ。**修飾子なしは通らない** |
| `…:function:my-function*` | 両方 |

## このプロジェクトで使う理由

このプロジェクトの IAM は、**サービスどうしの呼び出しの許可**だけで構成している。人の権限（`dev` へのデプロイに使うプロファイル）は扱わない（09「[ステージ](../09-architecture-specification.md#ステージ)」）。

| 呼ぶ側 → 呼ばれる側 | 許可の置き場所 |
|---|---|
| Scheduler → ステートマシン（`StartExecution`）・Scheduler の DLQ（`SendMessage`） | Scheduler の実行ロール（ID ベース） |
| ステートマシン → 投入・データ連携 Lambda（`InvokeFunction`） | ステートマシンのロール（ID ベース） |
| 投入 Lambda → メール送信キュー | 投入 Lambda のロール（ID ベース） |
| Consumer のイベントソースマッピング → メール送信キュー（受信・削除） | Consumer Lambda のロール（ID ベース）。キュー側のポリシーは置かない |
| データ連携 Lambda → S3・ステートマシン（`SendTask*`） | データ連携 Lambda のロール（ID ベース）。S3 側のバケットポリシーは HTTPS 以外を拒否するだけ |
| 各 Lambda → 自分のロググループ | 各 Lambda のロール（ID ベース） |
| EventBridge のルール 3 つ → Slack 通知 Lambda | Slack 通知 Lambda のリソースベースのポリシー（ルールごとに 1 つ） |

ロールごとの許可する操作と対象の一覧は、06「[認可（権限制御）](../06-security-specification.md#認可権限制御)」が正本。ロールはすべて Terraform が作り、CDK は作らない（09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」）。リソースベースのポリシーのうち、Lambda の 3 つは CDK がルールのターゲットを設定するときに付け、S3 のバケットポリシーは Terraform が付ける。

## 特徴と制約

### まだ無いリソースに、名前で先に権限を付ける

Terraform が先に土台（ロール）を作り、CDK が後から関数・ステートマシンを作る（09「[デプロイ](../09-architecture-specification.md#デプロイ)」）。ロールを作る時点では、権限の対象になる関数・ステートマシンはまだ存在せず、ARN を参照できない。

そこで、名前を命名規約（`serverless-practice-app-<stage>-<name>`）で先に決め、Terraform は**その名前から組み立てた ARN** で権限を付ける（09「[IaC の責務分担](../09-architecture-specification.md#iac-の責務分担)」の「名前の先決め」）。ARN はアカウント・リージョン・名前が分かれば作れるため、リソースが無くてもポリシーは書ける。名前が規約と違えば、権限は付いていても対象に当たらず、実行時に `AccessDenied` になる。

ワイルドカード（`*`）を使うのは、次の 3 か所だけ。

| 場所 | 意味 |
|---|---|
| ステートマシンのロールの `…:function:<name>:*` | 版・エイリアス付きの呼び出し。修飾子なしの ARN と並べて書き、両方の形を通す（上記「[Lambda の ARN と修飾子](#lambda-の-arn-と修飾子)」） |
| 各 Lambda のロールの `log-group:/aws/lambda/<name>:*` | そのロググループの中のログストリーム |
| データ連携 Lambda のロールの `<bucket>/exports/*` | 出力先の接頭辞の下のオブジェクト |

### CDK に権限を足させない

CDK の L2 は、つないだ相手への権限を自動で足す（`grant*`。ルールのターゲットにした関数、タスクで呼ぶ関数など）。このプロジェクトはロールを `mutable: false` で参照し、CDK がロールにポリシーを足せないようにしている。CDK のスタックが IAM のロール・ポリシーを 1 つも作らないことを、UT で固定している（[CDK 解説](cdk.md#権限を-cdk-に持たせない理由)）。

これで権限の正本が Terraform の 1 か所になる。代わりに、**CDK で新しいつながりを足したとき、必要な権限は自動では付かず、エラーにもならない。** 合成もデプロイも通り、実行して初めて `AccessDenied` になる。CDK の側でつながりを足したら、Terraform の `iam.tf` と 06 の表にも足す。

例外は、ルールから Lambda への呼び出しの許可。これはロールではなく**関数のリソースベースのポリシー**なので、`mutable: false` の対象外で、CDK がルールのターゲットを設定するときに付ける。合成したテンプレートで、3 つの許可はどれも `Principal` が `events.amazonaws.com`、`SourceArn` が対応するルールの ARN だった（2026-11-08 に `cdk synth` で確認）。つまり、**同じアカウントの別のルールからは呼べない**。UT はこの許可の件数（3）と `Principal` を固定しているが、`SourceArn` は固定していない。

### 信頼ポリシーの条件は、ロールによって違う

`aws:SourceAccount` の条件（自分のアカウントの代わりに動くときだけ引き受けを許す）は、ステートマシンのロールと Scheduler の実行ロールにだけ付いている。Lambda 4 種のロールと、LMI のオペレーターのロールには付いていない（`iam.tf`・`lmi.tf`）。

- Scheduler の公式の手順は、本番の実行ロールには混乱した代理を防ぐ条件を足すよう勧めている（公式「Setting up Amazon EventBridge Scheduler」）
- Lambda の実行ロールの公式のページは、信頼ポリシーの例に条件を付けておらず、条件キーにも触れていない（公式「Defining Lambda Event Function permissions with an execution role」）
- 条件を付けたロールで、`dev` の定時の起動・実行は動いている（09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）

Lambda のロールに条件を付けなかった理由は、コードにも仕様書にも記録が無い。付けた場合に Lambda がこの条件キーを渡すかは確かめていない。

### 権限の判定は、存在の確認より先に効いた

`dev` で、Scheduler のターゲットを存在しないステートマシン（`…-batch-missing`）へ一時的に変えたところ、起動の失敗は `StateMachineDoesNotExist` ではなく **`AccessDeniedException`** だった。実行ロールは `…-batch` 1 つにしか `StartExecution` を許していないためで、その ARN への許可を一時的に足すと、`StateMachineDoesNotExist` に変わった（実 AWS、2026-10-21、#101。09「[`dev` での検証結果](../09-architecture-specification.md#dev-での検証結果)」）。

**`AccessDenied` は「権限が足りない」だけでなく、「指している先が違う」ことも表しうる。** 名前の打ち間違い・ステージの取り違えでも、まず `AccessDenied` として現れる。

### 権限の過不足は `dev` で動かすまで分からない

最小の権限で足りているかは、次の理由で `dev` でしか確かめられない。

- LocalStack は既定で IAM のポリシーを評価しないため、権限が無くても動く（06「[認可](../06-security-specification.md#認可権限制御)」）
- CDK は `mutable: false` のロールに権限を足せなくてもエラーにしない（上記）

`dev` で確かめた例として、データ連携 Lambda の `SendTask*` は、対象をこのステートマシンの ARN に絞っても通った（実 AWS、2026-10-13。09「[実装で設計から変えた点](../09-architecture-specification.md#実装で設計から変えた点)」）。

### AWS 管理ポリシーを使うのは LMI のオペレーターだけ

`*` のアクション・リソースを使わない方針の例外として、LMI のキャパシティプロバイダが EC2 を操作するためのロールにだけ、公式の手順どおり AWS 管理ポリシー（`AWSLambdaManagedEC2ResourceOperator`）を付けている。`dev` で検証する間だけ存在する（06「[認可](../06-security-specification.md#認可権限制御)」・[LMI 解説](lmi.md)）。

## LocalStack との違い

| 違い | 正本 |
|---|---|
| 既定で IAM のポリシーを評価しない。ロール・ポリシーは作られるが、権限が足りなくても、指している先が違っても、呼び出しは通る | 06「[認可](../06-security-specification.md#認可権限制御)」・[EventBridge 解説](eventbridge.md#localstack-との違い) |

LocalStack 全体の性質は [LocalStack 解説](localstack.md#本物の-aws-との違い)を参照。

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| `local` では動くのに、`dev` で `AccessDenied` になる | LocalStack が IAM を評価していなかった。`dev` で足りない権限を `iam.tf` に足し、06 の表も直す |
| CDK でつながりを足し、合成もデプロイも通ったのに、実行すると `AccessDenied` になる | ロールが `mutable: false` で、CDK の `grant*` が足すはずの権限が付いていない。Terraform で足す |
| 存在するはずのリソースへの呼び出しが `AccessDenied` になる | 許可した ARN と、呼び出しが指した ARN が違う。名前の打ち間違い・ステージの取り違えを疑う。存在しない先への呼び出しも、権限が無ければ `AccessDenied` になる |
| Lambda を版・エイリアス付きで呼ぶと拒否される（または、その逆） | ポリシーの `Resource` が修飾子なしの ARN だけ（または `:*` だけ）。両方の形を並べて書く |
| ルールのターゲットにした Lambda が呼ばれない | 関数のリソースベースのポリシーが無い、または `SourceArn` が別のルールを指している。`aws lambda get-policy` で確かめる |
| ポリシーに `Allow` を書いたのに拒否される | どこかに明示の `Deny` がある（バケットポリシーの HTTPS 以外の拒否など）。明示の拒否は許可より強い |

## 参考資料

- [Policy evaluation for requests within a single account](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_policy-eval-basics.html)（明示の拒否・ID ベースとリソースベースの組み合わせ）
- [The confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)（`aws:SourceArn`・`aws:SourceAccount`）
- [Defining Lambda Event Function permissions with an execution role](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html)（実行ロールと信頼ポリシー）
- [Working with resource-based policies in Lambda](https://docs.aws.amazon.com/lambda/latest/dg/access-control-resource-based.html)
- [Fine-tuning the Resources and Conditions sections of policies](https://docs.aws.amazon.com/lambda/latest/dg/lambda-api-permissions-ref.html)（修飾子の有無と `:*`）
- [Setting up Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/setting-up.html)（実行ロールと混乱した代理の防止）
- [Security best practices for Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)（`aws:SecureTransport` で HTTPS 以外を拒否する）
