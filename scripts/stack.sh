#!/usr/bin/env bash
# 土台（Terraform）とアプリ（CDK）をまとめて作る・消す。順序を間違えないよう、この 1 本に固定する（docs/09「デプロイ」）。
#
# 使い方:
#   scripts/stack.sh <stage> up     Terraform → CDK の順に作る
#   scripts/stack.sh <stage> down   CDK → Terraform の順に消す
#
# local では確認を省く（LocalStack の中だけの使い捨てのため）。
# dev では Terraform・CDK の確認のプロンプトを残す（実 AWS のリソースを、確認なしで作ったり消したりしない）。
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "使い方: $0 {local|dev} {up|down}" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
stage="$1"
command="$2"

case "$stage" in
  local)
    tf_approve=(-auto-approve)
    cdk_deploy_approve=(--require-approval never)
    cdk_destroy_approve=(--force)
    ;;
  dev)
    tf_approve=()
    cdk_deploy_approve=()
    cdk_destroy_approve=()
    ;;
  *) usage ;;
esac

# 空の配列は ${a[@]+"${a[@]}"} で展開する。macOS 標準の bash 3.2 は、set -u の下で
# "${a[@]}" が空だと unbound variable で落ちるため（dev では確認の引数が空になる）
case "$command" in
  up)
    "${SCRIPTS_DIR}/terraform.sh" "$stage" init
    "${SCRIPTS_DIR}/terraform.sh" "$stage" apply ${tf_approve[@]+"${tf_approve[@]}"}
    "${SCRIPTS_DIR}/cdk.sh" "$stage" bootstrap
    "${SCRIPTS_DIR}/cdk.sh" "$stage" deploy ${cdk_deploy_approve[@]+"${cdk_deploy_approve[@]}"}
    ;;
  down)
    # CDK のスタックが参照中のロール・キューを先に消さないよう、CDK から消す
    "${SCRIPTS_DIR}/cdk.sh" "$stage" destroy ${cdk_destroy_approve[@]+"${cdk_destroy_approve[@]}"}
    # 別のシェル・新しいクローンからでも消せるよう、state の置き場所を設定し直してから消す
    "${SCRIPTS_DIR}/terraform.sh" "$stage" init
    "${SCRIPTS_DIR}/terraform.sh" "$stage" destroy ${tf_approve[@]+"${tf_approve[@]}"}
    ;;
  *) usage ;;
esac
