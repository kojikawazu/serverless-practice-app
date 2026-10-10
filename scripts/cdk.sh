#!/usr/bin/env bash
# アプリ（infra/cdk）を、ステージに応じた道具とコンテキストで操作する。
# README とデプロイの手順からはこのスクリプトか scripts/stack.sh を呼ぶだけにする（.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/cdk.sh <stage> bootstrap   CDK の作業用リソース（アセットの置き場所）を作る。何度実行してもよい
#   scripts/cdk.sh <stage> deploy      スタックを作る・更新する（Terraform を先に適用しておくこと）
#   scripts/cdk.sh <stage> destroy     スタックを消す（Terraform より先に消す。docs/09「デプロイ」）
#   後ろに付けた引数は、そのまま cdk に渡す（例: deploy --require-approval never）
#
# stage が local なら cdklocal（接続先を LocalStack に差し替える）、dev なら cdk を使う。
# どちらも npm の devDependencies から使う（バージョンを package-lock.json で固定するため）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "使い方: $0 {local|dev} {bootstrap|deploy|destroy} [cdk への追加の引数...]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
stage="$1"
command="$2"
shift 2

case "$stage" in
  local) cdk=cdklocal ;;
  dev) cdk=cdk ;;
  *) usage ;;
esac

case "$command" in
  bootstrap | deploy | destroy) ;;
  *) usage ;;
esac

# use_stage_aws は呼ばない。cdklocal は自分で AWS_* の環境変数（AWS_PROFILE を含む）を取り除いて
# ダミーの認証情報と LocalStack の接続先を設定し、AWS_ENDPOINT_URL を渡すとエラーで止まるため。
# dev では手元の AWS プロファイルをそのまま使う
cd "$REPO_ROOT"

# ステージはコンテキストで必ず渡す。未指定なら CDK アプリ側でエラーにする（infra/cdk/lib/stage.ts）
npx --no-install "$cdk" "$command" -c "stage=${stage}" "$@"
