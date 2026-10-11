#!/usr/bin/env bash
# 土台（infra/terraform）を、ステージに応じた道具・変数・state の置き場所で操作する。
# README とデプロイの手順からはこのスクリプトを呼ぶだけにする（コマンドを書き写さない。.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/terraform.sh <stage> init      state の置き場所（envs/<stage>.s3.tfbackend）を設定する
#   scripts/terraform.sh <stage> plan      envs/<stage>.tfvars で差分を見る
#   scripts/terraform.sh <stage> apply     envs/<stage>.tfvars で適用する
#   scripts/terraform.sh <stage> destroy   envs/<stage>.tfvars で削除する（CDK を先に消すこと。docs/09「デプロイ」）
#   plan / apply / destroy の後ろに付けた引数は、そのまま terraform に渡す（例: plan -detailed-exitcode）
#
# stage が local なら tflocal（接続先を LocalStack に差し替える）、dev なら terraform を使う。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${REPO_ROOT}/infra/terraform"

usage() {
  echo "使い方: $0 {local|dev} {init|plan|apply|destroy} [terraform への追加の引数...]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
stage="$1"
command="$2"
shift 2

case "$stage" in
  local) tf=tflocal ;;
  dev) tf=terraform ;;
  *) usage ;;
esac

if ! command -v "$tf" >/dev/null 2>&1; then
  echo "エラー: ${tf} が見つかりません（docs/09「前提ツール」）" >&2
  exit 1
fi

# Terraform（1.14 の AWS SDK）は aws login のプロファイルを読めない。AWS CLI で一時的な認証情報に変換し、
# 環境変数でこのプロセスにだけ渡す（ファイルには書かない）。認証情報が既に環境変数にあれば、そのまま使う
if [[ "$stage" == dev && -z "${AWS_ACCESS_KEY_ID:-}" ]]; then
  # 代入と eval を分ける。eval "$(...)" の形では、変換の失敗が eval の成功で上書きされて止まらないため
  if ! credentials="$(aws configure export-credentials --format env)"; then
    echo "エラー: AWS の認証情報を取り出せません。aws login --profile <名前> の後、AWS_PROFILE を設定して実行してください（docs/09「ステージ」）" >&2
    exit 1
  fi
  eval "$credentials"
  unset credentials
fi

# tflocal は作業ディレクトリに接続先の上書きファイルを書き出すため、-chdir ではなく移動して実行する
cd "$TF_DIR"

case "$command" in
  init)
    # 別のステージの state を指したまま操作しないよう、毎回 backend を設定し直す
    "$tf" init -reconfigure -input=false -backend-config="envs/${stage}.s3.tfbackend" "$@"
    ;;
  plan | apply | destroy)
    "$tf" "$command" -input=false -var-file="envs/${stage}.tfvars" "$@"
    ;;
  *)
    usage
    ;;
esac
