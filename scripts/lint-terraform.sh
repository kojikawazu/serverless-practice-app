#!/usr/bin/env bash
# 土台（infra/terraform）の整形と構文・型を検査する。CI（.github/workflows/ci.yml）とローカルが同じこのスクリプトを実行する。
#
# 使い方:
#   scripts/lint-terraform.sh
#
# 検査の中身:
#   1. terraform fmt -check   整形の差分が無いこと（直すときは terraform fmt -recursive）
#   2. terraform init -backend=false -lockfile=readonly
#                             state に触れずにプロバイダを取得する。ロックファイルに無い版・ハッシュなら失敗する
#   3. terraform validate     構文・参照・型の誤りが無いこと
#
# 手元の作業ディレクトリ（.terraform。backend の設定を持つ）を上書きしないよう、検査用の一時ディレクトリを使う。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}/infra/terraform"

TF_DATA_DIR="$(mktemp -d)"
export TF_DATA_DIR
trap 'rm -rf "$TF_DATA_DIR"' EXIT

terraform fmt -check -recursive
terraform init -backend=false -lockfile=readonly -input=false >/dev/null
terraform validate
