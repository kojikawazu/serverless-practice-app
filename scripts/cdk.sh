#!/usr/bin/env bash
# アプリ（infra/cdk）を、ステージに応じた道具とコンテキストで操作する。
# README とデプロイの手順からはこのスクリプトか scripts/stack.sh を呼ぶだけにする（.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/cdk.sh <stage> bootstrap   CDK の作業用リソース（アセットの置き場所）を作る。何度実行してもよい
#   scripts/cdk.sh <stage> deploy      スタックを作る・更新する（Terraform を先に適用しておくこと）
#   scripts/cdk.sh <stage> destroy     スタックを消す（Terraform より先に消す。docs/09「デプロイ」）
#   scripts/cdk.sh <stage> diff        デプロイ済みのスタックとの差分を出す。テンプレートを変えたら deploy の前に実行する
#   後ろに付けた引数は、そのまま cdk に渡す（例: deploy --require-approval never）
#
# stage が local なら cdklocal（接続先を LocalStack に差し替える）、dev なら cdk を使う。
# どちらも npm の devDependencies から使う（バージョンを package-lock.json で固定するため）。
#
# diff の終了コード:
#   0  差分が無い、または置換を伴わない差分だけ
#   3  置換（リソースの作り直し）を伴う差分がある。名前を固定したリソースは置換できず、上書きの deploy は失敗する
#      （docs/guides/cdk.md「明示しただけで、作り直しになることがある」）
#   1  cdk diff が失敗した、または差分の件数を出力から読み取れなかった（読めないことを「差分なし」と同じに扱わない）
#   2  引数の誤り
#
# diff の方法は明示する。cdk の既定（auto）は、変更セットを作れないとテンプレートの比較に切り替わり（cdk diff --help）、
# どちらで比べたのかを結果だけから読み取りにくいため。local では変更セットとテンプレートの両方で比べる。
# LocalStack の変更セットは、入れ子の項目の追加（Schedule の Target.RetryPolicy）を「差分なし」と返したことがあるため
# （docs/lessons-learned.md 2026-10-18）。dev は実 AWS の変更セットだけで比べる
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# diff の終了コード（上記）
EXIT_DIFF_FAILED=1
EXIT_DIFF_REPLACEMENT=3

usage() {
  echo "使い方: $0 {local|dev} {bootstrap|deploy|destroy|diff} [cdk への追加の引数...]" >&2
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
  bootstrap | deploy | destroy | diff) ;;
  *) usage ;;
esac

# use_stage_aws は呼ばない。cdklocal は自分で AWS_* の環境変数（AWS_PROFILE を含む）を取り除いて
# ダミーの認証情報と LocalStack の接続先を設定し、AWS_ENDPOINT_URL を渡すとエラーで止まるため。
# dev では手元の AWS プロファイルをそのまま使う
cd "$REPO_ROOT"

if [[ "$command" != diff ]]; then
  # ステージはコンテキストで必ず渡す。未指定なら CDK アプリ側でエラーにする（infra/cdk/lib/stage.ts）
  exec npx --no-install "$cdk" "$command" -c "stage=${stage}" "$@"
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# 1 つの方法で差分を出し、出力をそのまま見せたうえで、差分のあるスタックの数を標準出力に書く。
# 置換を伴う差分があれば、その印として $work_dir/replacement を作る。
# 使い方: run_diff <method> [cdk への追加の引数...]
run_diff() {
  local method="$1"
  shift
  local output="${work_dir}/${method}.log"
  echo "== cdk diff --method=${method}" >&2
  # 色の制御文字で判定が外れないよう、--no-color を付ける
  if ! npx --no-install "$cdk" diff -c "stage=${stage}" --method="$method" --no-color "$@" >"$output" 2>&1; then
    cat "$output" >&2
    echo "エラー: cdk diff（--method=${method}）が失敗しました" >&2
    exit "$EXIT_DIFF_FAILED"
  fi
  cat "$output" >&2

  local count
  count="$(sed -n 's/.*Number of stacks with differences: \([0-9][0-9]*\).*/\1/p' "$output" | tail -n 1)"
  if [[ -z "$count" ]]; then
    echo "エラー: cdk diff（--method=${method}）の出力から、差分のあるスタックの数を読み取れませんでした" >&2
    exit "$EXIT_DIFF_FAILED"
  fi

  # 項目の印（requires / may cause replacement）と、リソースの行の末尾の印（replace / may be replaced）のどちらかで判定する
  if grep -Eq '\((requires|may cause) replacement\)| (replace|may be replaced)$' "$output"; then
    touch "${work_dir}/replacement"
  fi
  echo "$count"
}

case "$stage" in
  local)
    change_set_count="$(run_diff change-set "$@")"
    template_count="$(run_diff template "$@")"
    echo "差分のあるスタック: 変更セット ${change_set_count} 件・テンプレート ${template_count} 件" >&2
    if [[ "$change_set_count" -eq 0 && "$template_count" -gt 0 ]]; then
      echo "警告: 変更セットでは差分が無く、テンプレートの比較では差分があります。LocalStack の変更セットが見落とした可能性があります" >&2
    fi
    ;;
  dev)
    change_set_count="$(run_diff change-set "$@")"
    echo "差分のあるスタック: 変更セット ${change_set_count} 件" >&2
    ;;
esac

if [[ -e "${work_dir}/replacement" ]]; then
  echo "置換を伴う差分があります。名前を固定したリソースは置換できないため、上書きの deploy は失敗します。scripts/stack.sh ${stage} down → up で作り直してください" >&2
  exit "$EXIT_DIFF_REPLACEMENT"
fi
