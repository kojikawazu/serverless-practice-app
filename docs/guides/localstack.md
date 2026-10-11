# LocalStack 解説

LocalStack とは何か、どう動くか、このプロジェクトでなぜ・どう使うかをまとめる。このプロジェクト固有の決定（イメージのタグ・認証の方針）は [09 アーキテクチャ仕様書](../09-architecture-specification.md) が正本で、起動のコマンドは [README](../../README.md#セットアップ) が正本。本書はそれらを参照し、本文を複製しない。

## 目次

- [LocalStack とは](#localstack-とは)
- [仕組み](#仕組み)
- [このプロジェクトで使う理由](#このプロジェクトで使う理由)
- [本物の AWS との違い](#本物の-aws-との違い)
- [関連する道具](#関連する道具)
- [認証とプラン](#認証とプラン)
- [つまずきやすい点](#つまずきやすい点)
- [参考資料](#参考資料)

## LocalStack とは

AWS のサービスを手元の PC 上で模倣する（エミュレートする）ツール。Docker のコンテナ 1 つとして動き、本物の AWS と同じ API の形で応答する。

AWS の SDK・CLI・Terraform・CDK は、接続先（エンドポイント）を LocalStack に向けるだけで、コードを変えずにそのまま使える。キューを作る・ファイルを置く・Lambda を実行する、といった操作が手元のコンテナの中で完結する。

## 仕組み

```text
本物の AWS を使う場合
  aws CLI / SDK / Terraform / CDK ──HTTPS──▶ AWS（東京リージョンなど）

LocalStack を使う場合
  aws CLI / SDK / Terraform / CDK ──HTTP──▶ 127.0.0.1:4566（手元の Docker コンテナ）
                                             └ SQS・S3・Lambda・Step Functions … を模倣
```

### 1 つのポートで全サービスを受ける

全サービスがポート 4566 を共有する。リクエストの中身（署名に含まれるサービス名やパス）から、どのサービス宛てかを LocalStack が振り分ける。

### Lambda は別のコンテナで動く

Lambda を呼び出すと、LocalStack が関数の実行用に別のコンテナを起動して、その中で関数を動かす。そのため LocalStack のコンテナに Docker のソケット（`/var/run/docker.sock`）を渡す必要がある（`docker-compose.yml` を参照）。

### 状態はコンテナと同じ寿命

作ったリソース（キュー・バケット・関数）はコンテナの中にあり、コンテナを消すと一緒に消える。このプロジェクトでは、この「使い捨て」の性質を前提にしている（Terraform の state も LocalStack 内に置く。09「Terraform の state」）。

### ヘルスチェック

`http://127.0.0.1:4566/_localstack/health` が、各サービスの状態（`available` / `running` / `disabled` など）を JSON で返す。このプロジェクトの起動スクリプト（`scripts/localstack.sh`）は、使う 9 サービスがすべて使える状態になるまでここを見て待つ。

## このプロジェクトで使う理由

[01 要求仕様書](../01-business-requirements.md)の「主要な決定事項」にあるとおり、「費用ゼロで繰り返し試し、最後に本物の挙動を確認する」ために、ステージを 2 つに分けている。

| 観点 | 本物の AWS（`dev`） | LocalStack（`local`） |
|---|---|---|
| 費用 | 従量課金（デモの量なら無料枠に収まる見込み） | 0 円（無料の Hobby プラン） |
| 速さ | デプロイに数分 | 速い。何度でも作って壊せる |
| 失敗したときの影響 | 実際のアカウントにリソースが残りうる | コンテナを消せば全部消える |
| 本物との一致 | 本物そのもの | 完全には一致しない（次節） |

## 本物の AWS との違い

LocalStack は模倣なので、細かな挙動が本物と違うことがある。違いが出やすいのは、サービス同士が裏側でつながる部分（定時起動・イベント配信・権限の評価など）。

このデモで特に確かめる必要があったのは次の 2 点で、結果（Scheduler は起動しない・状態変化イベントは届く）と代わりの手段を 09「LocalStack での検証結果」に記録している。

- EventBridge Scheduler が、決まった時刻に本当にステートマシンを起動するか
- Step Functions の状態変化イベントが、EventBridge rule に届くか

LocalStack で動かなければ手動での起動などで代わりに確かめ、本物どおりの確認は `dev` ステージで行う。**LocalStack で動いたことは、本物で動くことの証明にはならない。** 本物でしか確かめられない点は、最後に `dev` で確認する。

## 関連する道具

接続先を LocalStack に向ける「薄い包み」の道具がある。中身は本物の道具そのままで、接続先の設定だけを差し替える。

| 道具 | 元の道具 | 役割 |
|---|---|---|
| `tflocal` | Terraform | AWS Provider の接続先を LocalStack に向ける |
| `cdklocal` | AWS CDK | CDK のデプロイ先を LocalStack に向ける |
| `awslocal` | AWS CLI | CLI の接続先を LocalStack に向ける（使う場合） |

これらがあるので、Terraform と CDK のコードは本物の AWS 向けと LocalStack 向けで共通にできる。導入方法は 09「前提ツール」を参照。

## 認証とプラン

2026-03-23 以降、LocalStack は起動に LocalStack アカウントの認証トークン（`LOCALSTACK_AUTH_TOKEN`）が必要になった。それまでの無料のコミュニティ版イメージは廃止され、配布するイメージは 1 つにまとめられた。版の付け方も、セマンティック バージョン（`4.14.0` まで）からカレンダー形式（`2026.09.1` など）に変わった。

使える機能は、イメージではなく**トークンに紐づくプラン**で決まる。非商用なら無料の Hobby プランで、このプロジェクトが使う 9 サービスはすべて含まれる。

このプロジェクトでの扱い（どの版を使うか・トークンをどこに置くか・採らなかった案）は、09「LocalStack の認証」と [06 セキュリティ仕様書](../06-security-specification.md)の「データ保護」を参照。

## つまずきやすい点

| 症状 | 原因と対処 |
|---|---|
| `required variable LOCALSTACK_AUTH_TOKEN is missing a value` で起動しない | `.env` が無いか、トークンが空。`.env.example` をコピーして値を入れる |
| ヘルスチェックの `edition` が `pro` と表示される | イメージが 1 つにまとめられたための表記。実際の権限はプランで決まる。起動ログの `activated new license ...:freemium` が Hobby プランを指す |
| 初回の起動に時間がかかる | イメージ（数 GB）の取得。2 回目以降は速い |
| `down` したら作ったリソースが全部消えた | 仕様どおり（状態はコンテナと同じ寿命）。Terraform → CDK の順に作り直す |
| 別の PC やコンテナから 4566 に接続できない | `127.0.0.1` にだけ公開しているため（意図した設定）。手元からだけ使う |
| LocalStack では動くのに、本物の AWS で動かない | 模倣の限界。本物でしか確かめられない点は `dev` で確認する（前節） |

## 参考資料

- [LocalStack 公式ドキュメント](https://docs.localstack.cloud/)
- [LocalStack for AWS Is Moving to a Single Image. Here are Your Next Steps](https://blog.localstack.cloud/localstack-single-image-next-steps/)（単一イメージ化と認証トークンの必須化）
- [Announcing the LocalStack for AWS 2026.03.0 Release](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/)
- [LocalStack の料金プラン](https://www.localstack.cloud/pricing)（Hobby プランの範囲）
