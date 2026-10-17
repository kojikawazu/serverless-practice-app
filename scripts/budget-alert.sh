#!/usr/bin/env bash
# LMI の消し忘れに備える AWS Budgets の予算アラートを作り、設定をそろえる（docs/09「予算アラート」）。
# 予算はアカウント単位で、dev の down で消えては困るため、Terraform では管理しない（state バケットと同じ）。
# README と dev の手順からはこのスクリプトを呼ぶだけにする（.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/budget-alert.sh dev           ずれている設定だけを直す（何度実行しても同じ結果になる）
#   scripts/budget-alert.sh dev --check   直さずに比べるだけ。ずれがあれば終了コード 1
#
# stage は dev だけ。LocalStack は Budgets に対応していない（2026-10-13 に確認）。
# 直す前に確認のプロンプトを出す（実 AWS の設定を、確認なしで変えない）。
# 予算はこのスクリプトでは消さない（デモを畳むときに手で消す）。
#
# 終了コード: 0 = そろっている（直してそろった場合を含む）
#             1 = ずれがある（--check）・判定できない・直しても揃わない・中止した
#             2 = 使い方の誤り（引数・通知先のメールアドレス）
#
# 環境変数:
#   BUDGET_ALERT_EMAIL   通知先のメールアドレス。無ければ .env の同じ名前の 1 行だけを読む（.env を source しない）。
#                        個人情報のため、リポジトリに書かない（.env.example には変数名だけを置く）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# アカウント単位の予算のため、名前にステージを入れない（docs/09「予算アラート」）
BUDGET_NAME="serverless-practice-app-daily-cost"
# 日次の上限（USD）。LMI を 1 台のまま消し忘れた場合の最も安い費用（m6g.large で約 $2.85/日）を確実に越え、
# 他のプロジェクトの普段の費用（最大 $0.04/日）と dev での検証の日（実測 $0.12）は越えない額（docs/09「予算アラート」。#72）
BUDGET_LIMIT_USD=1
# 実績がこの割合（%）を超えたら知らせる
THRESHOLD_PERCENT=100
# Budgets の API はグローバルで、エンドポイントは us-east-1 にある
BUDGETS_REGION=us-east-1

usage() {
  echo "使い方: $0 dev [--check]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
[[ "$1" == dev ]] || usage
check=false
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--check" ]] || usage
  check=true
fi

# 通知先を環境変数、無ければ .env の 1 行から読む。.env には LocalStack の認証トークンもあるため source しない
email="${BUDGET_ALERT_EMAIL:-}"
if [[ -z "$email" && -f "${REPO_ROOT}/.env" ]]; then
  email="$(sed -n 's/^\(export \)\{0,1\}BUDGET_ALERT_EMAIL=//p' "${REPO_ROOT}/.env" | tail -n 1)"
  email="${email%\"}"
  email="${email#\"}"
  email="${email%\'}"
  email="${email#\'}"
fi
if [[ -z "$email" ]]; then
  echo "エラー: 通知先のメールアドレスがありません。BUDGET_ALERT_EMAIL を環境変数か .env に設定してください" >&2
  exit 2
fi
if [[ ! "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "エラー: BUDGET_ALERT_EMAIL がメールアドレスの形式ではありません" >&2
  exit 2
fi
# 画面には先頭の 1 文字とドメインだけを出す（個人情報をログに残さない）
masked_email="${email:0:1}***@${email#*@}"

budgets() {
  aws budgets --region "$BUDGETS_REGION" --output json "$@"
}

ACCOUNT_ID="$(aws sts get-caller-identity --output json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Account"])')" || {
  echo "エラー: アカウント ID を取得できませんでした（認証を確かめてください）" >&2
  exit 1
}

# あるべき設定。create 系の API にそのまま渡す形で書き、比較もこの形にそろえて行う
DESIRED_BUDGET="$(
  cat <<EOF
{"BudgetName":"${BUDGET_NAME}","BudgetType":"COST","TimeUnit":"DAILY","BudgetLimit":{"Amount":"${BUDGET_LIMIT_USD}","Unit":"USD"}}
EOF
)"
DESIRED_NOTIFICATION="$(
  cat <<EOF
{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":${THRESHOLD_PERCENT},"ThresholdType":"PERCENTAGE"}
EOF
)"
DESIRED_SUBSCRIBER="$(python3 -c 'import json, sys; print(json.dumps({"SubscriptionType": "EMAIL", "Address": sys.argv[1]}))' "$email")"

# AWS CLI を呼び、指定したエラーコード（$1）なら「無い」として 3 で返す。
# それ以外のエラー（権限不足・通信の失敗）は判定できないため、「無い」に丸めずに 1 で返す
call_or_absent() {
  local absent="$1" err out
  shift
  err="$(mktemp)"
  if out="$("$@" 2>"$err")"; then
    rm -f "$err"
    printf '%s' "$out"
    return 0
  fi
  if grep -q "(${absent})" "$err"; then
    rm -f "$err"
    return 3
  fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}

# 今の設定を 1 つの JSON にまとめて出す: {"budget": 予算 | null, "notifications": [{"notification": ..., "subscribers": [...]}]}
read_state() {
  local budget rc=0 notifications subscribers entries=() notification
  budget="$(call_or_absent NotFoundException budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME")" || rc=$?
  case "$rc" in
    0) ;;
    3)
      printf '{"budget":null,"notifications":[]}'
      return 0
      ;;
    *)
      echo "エラー: 予算 ${BUDGET_NAME} を読めませんでした" >&2
      return 1
      ;;
  esac
  # 予算があることは上で確かめた。通知が 1 件も無い予算に NotFoundException を返すかは確かめていないため、
  # その場合も「通知 0 件」として扱う（予算が無いこととは区別できている）
  rc=0
  notifications="$(call_or_absent NotFoundException budgets describe-notifications-for-budget --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME")" || rc=$?
  case "$rc" in
    0) ;;
    3) notifications='{"Notifications":[]}' ;;
    *)
      echo "エラー: 予算 ${BUDGET_NAME} の通知を読めませんでした" >&2
      return 1
      ;;
  esac
  while IFS= read -r notification; do
    [[ -n "$notification" ]] || continue
    subscribers="$(budgets describe-subscribers-for-notification --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" --notification "$notification")" || {
      echo "エラー: 予算 ${BUDGET_NAME} の通知先を読めませんでした" >&2
      return 1
    }
    entries+=("$(python3 -c '
import json, sys
print(json.dumps({"notification": json.loads(sys.argv[1]), "subscribers": json.loads(sys.argv[2]).get("Subscribers", [])}))
' "$notification" "$subscribers")")
  done < <(python3 -c '
import json, sys
for n in json.load(sys.stdin).get("Notifications", []):
    print(json.dumps(n))
' <<<"$notifications")
  python3 -c '
import json, sys
print(json.dumps({"budget": json.loads(sys.argv[1])["Budget"], "notifications": [json.loads(e) for e in sys.argv[2:]]}))
' "$budget" "${entries[@]+"${entries[@]}"}"
}

# 今の設定（標準入力）とあるべき設定を比べ、直す操作を 1 行 1 つ（種類<TAB>JSON）で出す。そろっていれば何も出さない。
# 同じ名前で種類・期間の違う予算は、別の用途のものとして直さずに 3 で終える。
# 比べるのはこのスクリプトが決める項目だけ（AWS が補う既定値・状態の項目でずれと誤判定しない）
plan() {
  python3 -c '
import json, sys
from decimal import Decimal

state = json.load(sys.stdin)
budget_want = json.loads(sys.argv[1])
notif_want = json.loads(sys.argv[2])
sub_want = json.loads(sys.argv[3])
keys = ["NotificationType", "ComparisonOperator", "Threshold", "ThresholdType"]
# 実 AWS は ThresholdType が既定値の PERCENTAGE なら、通知の応答から項目ごと省く（2026-10-15 に dev で観測。#69）
defaults = {"ThresholdType": "PERCENTAGE"}

def notif_key(n):
    key = {k: n.get(k, defaults.get(k)) for k in keys}
    if key["Threshold"] is not None:
        key["Threshold"] = float(key["Threshold"])
    return key

def sub_key(s):
    return (s.get("SubscriptionType"), s.get("Address"))

def out(kind, payload):
    print(kind + "\t" + json.dumps(payload))

budget = state["budget"]
if budget is None:
    out("create-budget", {})
    sys.exit(0)
for key in ["BudgetType", "TimeUnit"]:
    if budget.get(key) != budget_want[key]:
        print("予算 %s の %s が %s です（期待: %s）。別の用途の予算の可能性があるため、直さずに止めます"
              % (budget_want["BudgetName"], key, budget.get(key), budget_want[key]), file=sys.stderr)
        sys.exit(3)
limit = budget.get("BudgetLimit") or {}
limit_want = budget_want["BudgetLimit"]
if limit.get("Unit") != limit_want["Unit"] or Decimal(limit.get("Amount", "0")) != Decimal(limit_want["Amount"]):
    out("update-budget", {"current": limit})

matched = None
for entry in state["notifications"]:
    if matched is None and notif_key(entry["notification"]) == notif_key(notif_want):
        matched = entry
    else:
        out("delete-notification", entry["notification"])
if matched is None:
    out("create-notification", notif_want)
else:
    subs = matched["subscribers"]
    if sub_key(sub_want) not in [sub_key(s) for s in subs]:
        out("create-subscriber", sub_want)
    for s in subs:
        if sub_key(s) != sub_key(sub_want):
            out("delete-subscriber", s)
' "$DESIRED_BUDGET" "$DESIRED_NOTIFICATION" "$DESIRED_SUBSCRIBER"
}

# 操作を画面向けの 1 行にする。メールアドレスは伏せる
describe_action() {
  local kind="$1" payload="$2"
  case "$kind" in
    create-budget) printf '予算を作る（日次 %s USD、実績が %s%% を超えたら %s へメール）' "$BUDGET_LIMIT_USD" "$THRESHOLD_PERCENT" "$masked_email" ;;
    update-budget) printf '予算の額を直す（現在: %s → 期待: %s USD）' "$payload" "$BUDGET_LIMIT_USD" ;;
    create-notification) printf '通知を足す（実績が %s%% を超えたら %s へメール）' "$THRESHOLD_PERCENT" "$masked_email" ;;
    delete-notification) printf '余分な通知を消す（%s）' "$payload" ;;
    create-subscriber) printf '通知先を足す（%s）' "$masked_email" ;;
    delete-subscriber) printf '余分な通知先を消す（%s）' "$(python3 -c 'import json, sys; s = json.loads(sys.argv[1]); a = s.get("Address", ""); print(s.get("SubscriptionType"), a[:1] + "***@" + a.split("@")[-1] if "@" in a else "***")' "$payload")" ;;
  esac
}

# 操作を実行する
apply_action() {
  local kind="$1" payload="$2" target=(--account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME")
  case "$kind" in
    create-budget)
      budgets create-budget --account-id "$ACCOUNT_ID" --budget "$DESIRED_BUDGET" \
        --notifications-with-subscribers "$(python3 -c 'import json, sys; print(json.dumps([{"Notification": json.loads(sys.argv[1]), "Subscribers": [json.loads(sys.argv[2])]}]))' "$DESIRED_NOTIFICATION" "$DESIRED_SUBSCRIBER")"
      ;;
    update-budget) budgets update-budget --account-id "$ACCOUNT_ID" --new-budget "$DESIRED_BUDGET" ;;
    create-notification) budgets create-notification "${target[@]}" --notification "$DESIRED_NOTIFICATION" --subscribers "[${DESIRED_SUBSCRIBER}]" ;;
    delete-notification) budgets delete-notification "${target[@]}" --notification "$payload" ;;
    create-subscriber) budgets create-subscriber "${target[@]}" --notification "$DESIRED_NOTIFICATION" --subscriber "$DESIRED_SUBSCRIBER" ;;
    delete-subscriber) budgets delete-subscriber "${target[@]}" --notification "$DESIRED_NOTIFICATION" --subscriber "$payload" ;;
  esac
}

# 今の設定を読み、直す操作を出す。判定できなければ 1 で返す
compute_plan() {
  local state rc=0 actions
  state="$(read_state)" || return 1
  actions="$(plan <<<"$state")" || rc=$?
  [[ "$rc" -eq 0 ]] || return 1
  printf '%s' "$actions"
}

echo "予算 ${BUDGET_NAME}（アカウント ${ACCOUNT_ID}、通知先 ${masked_email}）"

# 1. 比べて、直す操作を集める
actions="$(compute_plan)" || exit 1
if [[ -z "$actions" ]]; then
  echo "すべての設定がそろっています"
  exit 0
fi
count=0
while IFS=$'\t' read -r kind payload; do
  printf '  %s\n' "$(describe_action "$kind" "$payload")"
  count=$((count + 1))
done <<<"$actions"
if [[ "$check" == true ]]; then
  echo "ずれがある項目: ${count} 件（直すには --check を付けずに実行してください）" >&2
  exit 1
fi

# 2. 直す前に確認する
read -r -p "上の ${count} 件を、アカウント ${ACCOUNT_ID} で直します。よろしいですか？ [y/N] " answer || answer=""
if [[ "$answer" != y ]]; then
  echo "中止しました" >&2
  exit 1
fi

# 3. 直す。応答（作った・消した結果）は使わないため捨てる
while IFS=$'\t' read -r kind payload; do
  apply_action "$kind" "$payload" >/dev/null || {
    echo "エラー: $(describe_action "$kind" "$payload") に失敗しました" >&2
    exit 1
  }
  printf '  完了: %s\n' "$(describe_action "$kind" "$payload")"
done <<<"$actions"

# 4. 読み直し、そろったことを確かめる（API が成功を返しても、反映を確認するまで成功としない）
remaining="$(compute_plan)" || exit 1
if [[ -n "$remaining" ]]; then
  echo "エラー: 直しましたが、読み直すとそろっていません" >&2
  printf '%s\n' "$remaining" | cut -f1 >&2
  exit 1
fi
echo "すべての設定がそろいました"
