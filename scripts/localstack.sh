#!/usr/bin/env bash
# local ステージ用の LocalStack を起動・停止する。README からはこのスクリプトを呼ぶだけにする
# （起動手順を README・CI に書き分けない。.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/localstack.sh up     起動し、使うサービスがすべて使える状態になるまで待つ
#   scripts/localstack.sh down   停止してコンテナを消す（LocalStack 内のリソースも消える）
#
# 環境変数:
#   LOCALSTACK_ENDPOINT         ヘルスチェックの接続先（既定: http://127.0.0.1:4566）
#   LOCALSTACK_WAIT_SECONDS     up で待つ最大秒数（既定: 120）
#
# up は「待った結果、使えないサービスが残った」場合も、「ヘルスチェックに一度も応答が無かった」
# 場合も失敗で終える。応答が無いことを「使えないサービス 0 件」と同じに扱わない。
set -euo pipefail

# このデモが使うサービス（docs/04「対応環境」）。ヘルスチェックの名前で書く
REQUIRED_SERVICES="lambda sqs s3 stepfunctions scheduler events ssm iam logs"
WAIT_SECONDS="${LOCALSTACK_WAIT_SECONDS:-120}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/aws-stage.sh
source "${REPO_ROOT}/scripts/lib/aws-stage.sh"
ENDPOINT="$LOCALSTACK_ENDPOINT"
cd "$REPO_ROOT"

# ヘルスチェックの JSON を標準入力から読み、使えないサービスを空白区切りで出力する。
# 応答に載っていないサービスも「使えない」に含める（載っていないことを使えると見なさない）。
# JSON として読めなければ終了コード 2 で終える。
unavailable_services() {
  python3 -c '
import json, sys
required = sys.argv[1].split()
try:
    services = json.load(sys.stdin).get("services", {})
except ValueError:
    sys.exit(2)
print(" ".join(s for s in required if services.get(s) not in ("available", "running")))
' "$REQUIRED_SERVICES"
}

wait_until_ready() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  local responded=false
  local missing="$REQUIRED_SERVICES"
  local health current

  while ((SECONDS < deadline)); do
    if health="$(curl -sf "${ENDPOINT}/_localstack/health")"; then
      responded=true
      # 応答を判定できたときだけ missing を更新する（読めない応答で「0 件」に上書きしない）
      if current="$(printf '%s' "$health" | unavailable_services)"; then
        missing="$current"
        if [[ -z "$missing" ]]; then
          echo "LocalStack が使える状態になりました（${ENDPOINT}）"
          return 0
        fi
      fi
    fi
    sleep 2
  done

  if [[ "$responded" == false ]]; then
    echo "エラー: ${WAIT_SECONDS} 秒待っても LocalStack のヘルスチェック（${ENDPOINT}）に応答がありません" >&2
    echo "  docker compose logs localstack で起動ログを確認してください（認証トークンの誤りを含む）" >&2
  else
    echo "エラー: ${WAIT_SECONDS} 秒待っても使えないサービスがあります: ${missing}" >&2
  fi
  return 1
}

case "${1:-}" in
  up)
    docker compose up -d
    wait_until_ready
    ;;
  down)
    docker compose down
    ;;
  *)
    echo "使い方: $0 {up|down}" >&2
    exit 2
    ;;
esac
