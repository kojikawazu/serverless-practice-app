#!/usr/bin/env bash
# バッチ（ステートマシン）を手動で起動し、結果を確かめる（docs/03「操作方針」）。
# README と手動確認の手順からはこのスクリプトを呼ぶだけにする（.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/batch.sh <stage> run [failAt] [--hold-seconds <秒>]
#                                            実行を起動し、終わるまで待って結果を出す
#                                            failAt: enqueue / dataSync / consumer（省略で失敗を注入しない）
#                                            --hold-seconds: データ連携 Lambda が結果を返す前に待つ秒数（docs/02「F-6」）
#   scripts/batch.sh <stage> logs <実行名>   4 つの Lambda のログから、その実行名を含む行だけを出す
#   scripts/batch.sh <stage> dlq             DLQ のメッセージ数を出す
#
# run の終了コードは、実行が終わったかどうかで決まる（SUCCEEDED / FAILED のどちらでも 0）。
# 失敗の注入では FAILED が期待どおりの結果のため。待っても終わらなかった場合だけ 1 で終える
# （終わったかどうか分からない状態を、成功扱いにしない）。
#
# 環境変数:
#   BATCH_WAIT_SECONDS   run で待つ最大秒数（既定: 360 + holdSeconds。待たせない実行は数十秒で終わるため 360 秒で足り、
#                        holdSeconds を付けたらその分だけ延ばす）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/aws-stage.sh
source "${REPO_ROOT}/scripts/lib/aws-stage.sh"

# holdSeconds を付けない実行で待つ最大秒数
BASE_WAIT_SECONDS=360
# holdSeconds の上限（docs/02「データ項目」）。これを超える値は検証エラーですぐ終わるため、待つ秒数に足さない
MAX_HOLD_SECONDS=1200
FUNCTIONS="enqueue consumer data-sync notify-slack"

usage() {
  echo "使い方: $0 {local|dev} run [enqueue|dataSync|consumer] [--hold-seconds <秒>]" >&2
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
  # 一覧を取れなかったこと（認証切れ・接続先の誤り）を「見つからない」と区別する。
  # この関数は $(...) の中で呼ばれ、bash 3.2 ではそこに set -e が引き継がれないため、終了コードを明示的に見る
  if ! arn="$(aws stepfunctions list-state-machines \
    --query "stateMachines[?name=='${prefix}-batch'].stateMachineArn | [0]" --output text)"; then
    echo "エラー: ステートマシンの一覧を取得できません。AWS の認証（aws login）と接続先を確認してください" >&2
    return 1
  fi
  if [[ -z "$arn" || "$arn" == "None" ]]; then
    echo "エラー: ステートマシン ${prefix}-batch が見つかりません。scripts/stack.sh ${stage} up でデプロイしてください" >&2
    return 1
  fi
  printf '%s' "$arn"
}

run() {
  # bash 3.2 の set -u では空の配列を展開できないため、配列を使わずに受ける
  local fail_at="" has_fail_at=0 hold_seconds="" has_hold_seconds=0
  while (($# > 0)); do
    case "$1" in
      --hold-seconds)
        (($# >= 2)) || usage
        hold_seconds="$2"
        has_hold_seconds=1
        shift 2
        ;;
      # 綴りを誤ったオプションを failAt として起動しない
      -*) usage ;;
      *)
        ((has_fail_at == 0)) || usage
        fail_at="$1"
        has_fail_at=1
        shift
        ;;
    esac
  done

  # 未定義の値も、そのまま渡せるようにする（検証エラーで FAILED になることを確かめるため。docs/02「F-6」）。
  # holdSeconds は JSON の数値として読める形（1.5・-1 を含む）なら数値で、それ以外は文字列で渡す
  local input
  input="$(python3 -c '
import json, re, sys
has_fail_at, fail_at, has_hold_seconds, hold_seconds = sys.argv[1:]
body = {}
if has_fail_at == "1":
    body["failAt"] = fail_at
if has_hold_seconds == "1":
    is_number = re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", hold_seconds)
    body["holdSeconds"] = json.loads(hold_seconds) if is_number else hold_seconds
print(json.dumps(body))
' "$has_fail_at" "$fail_at" "$has_hold_seconds" "$hold_seconds")"

  local wait_seconds="${BATCH_WAIT_SECONDS:-}"
  if [[ -z "$wait_seconds" ]]; then
    wait_seconds=$BASE_WAIT_SECONDS
    # 桁数を先に見て、bash の整数の範囲を超える値で計算しない
    if [[ "$hold_seconds" =~ ^(0|[1-9][0-9]{0,3})$ ]] && ((hold_seconds <= MAX_HOLD_SECONDS)); then
      wait_seconds=$((wait_seconds + hold_seconds))
    fi
  fi

  local arn name execution_arn
  arn="$(state_machine_arn)"
  # 実行名の形式は docs/07 の例（manual-YYYYMMDD-...）に合わせる。秒まで入れて手動の連続実行でも衝突させない
  name="manual-$(date +%Y%m%d-%H%M%S)"
  execution_arn="$(aws stepfunctions start-execution \
    --state-machine-arn "$arn" --name "$name" --input "$input" \
    --query executionArn --output text)"
  echo "起動しました: ${name}（入力: ${input}、最大 ${wait_seconds} 秒待ちます）"

  local deadline=$((SECONDS + wait_seconds)) status
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
  echo "エラー: ${wait_seconds} 秒待っても実行 ${name} が終わりません（状態: RUNNING）" >&2
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
