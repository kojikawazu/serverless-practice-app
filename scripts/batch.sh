#!/usr/bin/env bash
# バッチ（ステートマシン）を手動で起動し、結果を確かめる（docs/03「操作方針」）。
# README と手動確認の手順からはこのスクリプトを呼ぶだけにする（.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/batch.sh <stage> run [failAt] [--hold-seconds <秒>]
#                                            実行を起動し、終わるまで待って結果を出す
#                                            failAt: enqueue / dataSync / consumer / consumerAfterSend（省略で失敗を注入しない）
#                                            --hold-seconds: データ連携 Lambda が結果を返す前に待つ秒数（docs/02「F-6」）
#   scripts/batch.sh <stage> rerun <元の実行名> [failAt] [--hold-seconds <秒>]
#                                            失敗した実行を、論理キーを引き継いで再実行する（docs/03「失敗の後の再実行」）。
#                                            実行入力の rerunOf に最初の実行の名前を入れる。元の failAt / holdSeconds は引き継がない
#                                            元の実行が見つからない・実行中・最初の実行の開始から 7 日を過ぎているときは起動せずに 1 で終える
#   scripts/batch.sh <stage> logs <実行名>   4 つの Lambda のログから、その実行名を含む行だけを出す
#                                            最初の実行の名前を渡すと、再実行の行も出る（ログに runKey があるため）
#   scripts/batch.sh <stage> dlq             DLQ のメッセージ数を出す
#
# run / rerun の終了コードは、実行が終わったかどうかで決まる（SUCCEEDED / FAILED のどちらでも 0）。
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
# 再実行を受け付ける期間（秒）。送信記録の期限（7 日。docs/04「保持期間」）を過ぎると、送れていたメールの記録が
# 消えている可能性があり、送り直しうる。期限は記録を書いた時刻から数えるため、最初の実行の開始から数えれば安全側になる
RERUN_WINDOW_SECONDS=$((7 * 24 * 60 * 60))
# 実行名の制約（docs/06「入力バリデーション」）。rerunOf として渡す値も同じ制約で Lambda が検証する
EXECUTION_NAME_PATTERN='^[A-Za-z0-9_-]{1,80}$'

usage() {
  echo "使い方: $0 {local|dev} run [enqueue|dataSync|consumer|consumerAfterSend] [--hold-seconds <秒>]" >&2
  echo "        $0 {local|dev} rerun <元の実行名> [enqueue|dataSync|consumer|consumerAfterSend] [--hold-seconds <秒>]" >&2
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

# run / rerun の引数（failAt・--hold-seconds）を読む。誤りなら、AWS を呼ぶ前に使い方を出して止める。
# bash 3.2 には変数の参照渡しが無く、set -u では空の配列を展開できないため、結果はグローバル変数で受け渡す
fail_at=""
has_fail_at=0
hold_seconds=""
has_hold_seconds=0
parse_start_args() {
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
}

# 実行入力を組み立てて起動し、終わるまで待って結果を出す（run / rerun 共通）。
# 引数: ステートマシンの ARN、実行名の接頭辞（manual / rerun）、rerunOf（再実行でなければ空）
start_and_wait() {
  local arn="$1" name_prefix="$2" rerun_of="$3"

  # 未定義の値も、そのまま渡せるようにする（検証エラーで FAILED になることを確かめるため。docs/02「F-6」）。
  # holdSeconds は JSON の数値として読める形（1.5・-1 を含む）なら数値で、それ以外は文字列で渡す
  local input
  input="$(python3 -c '
import json, re, sys
has_fail_at, fail_at, has_hold_seconds, hold_seconds, rerun_of = sys.argv[1:]
body = {}
if rerun_of != "":
    body["rerunOf"] = rerun_of
if has_fail_at == "1":
    body["failAt"] = fail_at
if has_hold_seconds == "1":
    is_number = re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", hold_seconds)
    body["holdSeconds"] = json.loads(hold_seconds) if is_number else hold_seconds
print(json.dumps(body))
' "$has_fail_at" "$fail_at" "$has_hold_seconds" "$hold_seconds" "$rerun_of")"

  local wait_seconds="${BATCH_WAIT_SECONDS:-}"
  if [[ -z "$wait_seconds" ]]; then
    wait_seconds=$BASE_WAIT_SECONDS
    # 桁数を先に見て、bash の整数の範囲を超える値で計算しない
    if [[ "$hold_seconds" =~ ^(0|[1-9][0-9]{0,3})$ ]] && ((hold_seconds <= MAX_HOLD_SECONDS)); then
      wait_seconds=$((wait_seconds + hold_seconds))
    fi
  fi

  local name execution_arn
  # 実行名の形式は docs/07 の例（manual-YYYYMMDD-...）に合わせる。秒まで入れて手動の連続実行でも衝突させない
  name="${name_prefix}-$(date +%Y%m%d-%H%M%S)"
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

run() {
  parse_start_args "$@"
  local arn
  arn="$(state_machine_arn)"
  start_and_wait "$arn" manual ""
}

# 実行を describe-execution で読み、「状態|rerunOf|開始時刻（エポック秒）」を 1 行で出す。
# 区切りに | を使うのは、タブだと read が空の欄（rerunOf が無い）を詰めて値がずれるため（| は実行名に使えない）。
# rerunOf が無ければ空。見つからない・読めない・入力の rerunOf が壊れているときは、理由を出して 1 を返す
# （判定できないことを「見つからない」「再実行ではない」に丸めない。.claude/rules/error-handling.md）。
# 引数: ステートマシンの ARN、実行名、エラーで呼ぶ名前（元の実行 / 最初の実行）
describe_execution_facts() {
  local arn="$1" name="$2" label="$3" execution_arn described err
  execution_arn="${arn/:stateMachine:/:execution:}:${name}"
  err="$(mktemp)"
  # この関数は $(...) の中で呼ばれ、bash 3.2 ではそこに set -e が引き継がれないため、終了コードを明示的に見る
  if ! described="$(aws stepfunctions describe-execution --execution-arn "$execution_arn" --output json 2>"$err")"; then
    if grep -q '(ExecutionDoesNotExist)' "$err"; then
      echo "エラー: ${label} ${name} が見つかりません。実行名を確かめてください" >&2
    else
      cat "$err" >&2
      echo "エラー: ${label} ${name} を読めません。AWS の認証（aws login）と接続先を確認してください" >&2
    fi
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  # startDate は AWS CLI がオフセット付きの ISO 8601 で出す（LocalStack で観測。2026-11-09・#137）。
  # input は JSON の文字列のまま入っている
  printf '%s' "$described" | python3 -c '
import datetime, json, re, sys
pattern, name, label = sys.argv[1:]
execution = json.load(sys.stdin)
try:
    rerun_of = json.loads(execution.get("input") or "{}").get("rerunOf", "")
except (ValueError, AttributeError):
    rerun_of = None
if rerun_of != "" and not (isinstance(rerun_of, str) and re.fullmatch(pattern, rerun_of)):
    print(f"エラー: {label} {name} の入力の rerunOf が実行名の形式ではありません: {rerun_of!r}", file=sys.stderr)
    sys.exit(1)
try:
    started = int(datetime.datetime.fromisoformat(execution["startDate"]).timestamp())
    status = execution["status"]
except (KeyError, TypeError, ValueError):
    print(f"エラー: {label} {name} の状態・開始時刻を読めません", file=sys.stderr)
    sys.exit(1)
print("|".join([status, rerun_of, str(started)]))
' "$EXECUTION_NAME_PATTERN" "$name" "$label"
}

rerun() {
  (($# >= 1)) || usage
  local original="$1"
  shift
  # 綴りを誤ったオプションを元の実行名として読まない
  [[ "$original" != -* ]] || usage
  parse_start_args "$@"
  if ! [[ "$original" =~ $EXECUTION_NAME_PATTERN ]]; then
    echo "エラー: 実行名の形式ではありません: ${original}（80 文字以内、英数字・-・_ のみ）" >&2
    return 1
  fi

  local arn facts status rerun_of started root
  arn="$(state_machine_arn)"
  facts="$(describe_execution_facts "$arn" "$original" 元の実行)" || return 1
  IFS='|' read -r status rerun_of started <<<"$facts"
  if [[ "$status" == "RUNNING" ]]; then
    echo "エラー: 元の実行 ${original} はまだ実行中です。終わってから再実行してください（重なりは docs/03「失敗の後の再実行」）" >&2
    return 1
  fi
  # 再実行の再実行は、元の実行が引き継いでいた最初の実行の名前を引き継ぐ。7 日も最初の実行の開始から数える
  root="${rerun_of:-$original}"
  if [[ "$root" != "$original" ]]; then
    facts="$(describe_execution_facts "$arn" "$root" 最初の実行)" || return 1
    IFS='|' read -r status rerun_of started <<<"$facts"
    if [[ "$status" == "RUNNING" ]]; then
      echo "エラー: 最初の実行 ${root} はまだ実行中です。終わってから再実行してください" >&2
      return 1
    fi
  fi
  if (($(date +%s) - started > RERUN_WINDOW_SECONDS)); then
    echo "エラー: 最初の実行 ${root} の開始から 7 日を過ぎています。送信記録が消えている可能性があり、送れていたメールを送り直しうるため再実行しません（docs/04「保持期間」）" >&2
    return 1
  fi

  echo "再実行します: ${original} の論理キー ${root} を引き継ぎます"
  start_and_wait "$arn" rerun "$root"
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
  rerun) rerun "$@" ;;
  logs) logs "$@" ;;
  dlq) dlq "$@" ;;
  *) usage ;;
esac
