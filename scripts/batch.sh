#!/usr/bin/env bash
# バッチ（ステートマシン）を手動で起動し、結果を確かめる（docs/03「操作方針」）。
# README と手動確認の手順からはこのスクリプトを呼ぶだけにする（.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/batch.sh <stage> run [failAt]    実行を起動し、終わるまで待って結果を出す
#                                            failAt: enqueue / dataSync / consumer（省略で失敗を注入しない）
#   scripts/batch.sh <stage> logs <実行名>   4 つの Lambda のログから、その実行名を含む行だけを出す
#   scripts/batch.sh <stage> dlq             DLQ のメッセージ数を出す
#
# run の終了コードは、実行が終わったかどうかで決まる（SUCCEEDED / FAILED のどちらでも 0）。
# 失敗の注入では FAILED が期待どおりの結果のため。待っても終わらなかった場合だけ 1 で終える
# （終わったかどうか分からない状態を、成功扱いにしない）。
#
# 環境変数:
#   BATCH_WAIT_SECONDS   run で待つ最大秒数（既定: 360。ステートマシンのタイムアウト 5 分より長くする）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/aws-stage.sh
source "${REPO_ROOT}/scripts/lib/aws-stage.sh"

WAIT_SECONDS="${BATCH_WAIT_SECONDS:-360}"
FUNCTIONS="enqueue consumer data-sync notify-slack"

usage() {
  echo "使い方: $0 {local|dev} run [enqueue|dataSync|consumer]" >&2
  echo "        $0 {local|dev} logs <実行名>" >&2
  echo "        $0 {local|dev} dlq" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
stage="$1"
command="$2"
shift 2

case "$stage" in
  local | dev) ;;
  *) usage ;;
esac
use_stage_aws "$stage"
prefix="$(resource_prefix "$stage")"

# ステートマシンの ARN を名前から引く。見つからなければ、デプロイ漏れとして止める
state_machine_arn() {
  local arn
  arn="$(aws stepfunctions list-state-machines \
    --query "stateMachines[?name=='${prefix}-batch'].stateMachineArn | [0]" --output text)"
  if [[ -z "$arn" || "$arn" == "None" ]]; then
    echo "エラー: ステートマシン ${prefix}-batch が見つかりません。scripts/stack.sh ${stage} up でデプロイしてください" >&2
    return 1
  fi
  printf '%s' "$arn"
}

run() {
  [[ $# -le 1 ]] || usage
  # 未定義の値も、そのまま渡せるようにする（検証エラーで FAILED になることを確かめるため。docs/02「F-6」）
  local input
  input="$(python3 -c 'import json, sys; print(json.dumps({"failAt": sys.argv[1]} if len(sys.argv) > 1 else {}))' "$@")"

  local arn name execution_arn
  arn="$(state_machine_arn)"
  # 実行名の形式は docs/07 の例（manual-YYYYMMDD-...）に合わせる。秒まで入れて手動の連続実行でも衝突させない
  name="manual-$(date +%Y%m%d-%H%M%S)"
  execution_arn="$(aws stepfunctions start-execution \
    --state-machine-arn "$arn" --name "$name" --input "$input" \
    --query executionArn --output text)"
  echo "起動しました: ${name}（入力: ${input}）"

  local deadline=$((SECONDS + WAIT_SECONDS)) status
  while ((SECONDS < deadline)); do
    status="$(aws stepfunctions describe-execution --execution-arn "$execution_arn" --query status --output text)"
    if [[ "$status" != "RUNNING" ]]; then
      # cause は Lambda のエラー（スタックトレース付きの JSON）が入り長いため、読めればメッセージだけを出す
      aws stepfunctions describe-execution --execution-arn "$execution_arn" --output json |
        python3 -c '
import json, sys
execution = json.load(sys.stdin)
cause = execution.get("cause")
try:
    cause = json.loads(cause)["errorMessage"]
except (TypeError, ValueError, KeyError):
    pass
print("状態: " + execution["status"])
print("エラー: " + execution.get("error", "-"))
print("原因: " + (cause if cause is not None else "-"))
'
      echo "ログ: $0 ${stage} logs ${name}"
      return 0
    fi
    sleep 2
  done
  echo "エラー: ${WAIT_SECONDS} 秒待っても実行 ${name} が終わりません（状態: RUNNING）" >&2
  return 1
}

logs() {
  [[ $# -eq 1 ]] || usage
  local name="$1" fn
  for fn in $FUNCTIONS; do
    echo "== ${fn}"
    # filter-pattern の対応は LocalStack と AWS で差があるため、全件を取って手元で絞り込む。
    # 該当 0 件は正常（例: failAt=enqueue の実行では Consumer のログが出ない）なので、grep の終了コードで落とさない
    aws logs filter-log-events --log-group-name "/aws/lambda/${prefix}-${fn}" \
      --query 'events[].message' --output json |
      python3 -c '
import json, sys
name = sys.argv[1]
for message in json.load(sys.stdin):
    if name in message:
        print(message.rstrip("\n"))
' "$name"
  done
}

dlq() {
  [[ $# -eq 0 ]] || usage
  local url
  url="$(aws sqs get-queue-url --queue-name "${prefix}-mail-dlq.fifo" --query QueueUrl --output text)"
  aws sqs get-queue-attributes --queue-url "$url" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query Attributes --output table
}

case "$command" in
  run) run "$@" ;;
  logs) logs "$@" ;;
  dlq) dlq "$@" ;;
  *) usage ;;
esac
