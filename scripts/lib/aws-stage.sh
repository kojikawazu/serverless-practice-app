# shellcheck shell=bash
# ステージごとの AWS 接続設定。scripts/*.sh から source して使う（単体では実行しない）。
# LocalStack の接続先とダミーの認証情報を、スクリプトごとに書き写さないためにここへ置く（.claude/rules/duplication.md）。

# LocalStack の接続先。test/it/helpers/localstack.ts も同じ環境変数名・既定値を使う
LOCALSTACK_ENDPOINT="${LOCALSTACK_ENDPOINT:-http://127.0.0.1:4566}"

# リソース名の接頭辞（docs/10「命名」）
# 使い方: resource_prefix <stage>
resource_prefix() {
  printf 'serverless-practice-app-%s' "$1"
}

# stage が local なら、AWS CLI・SDK の接続先を LocalStack に向け、ダミーの認証情報を使う。
# 手元の AWS プロファイル（実 AWS の認証情報）を local の操作で使わないよう、認証情報も必ず上書きする。
# dev では何もしない（手元の AWS プロファイルで認証する。docs/09「ステージ」）。
# 使い方: use_stage_aws <stage>
use_stage_aws() {
  case "$1" in
    local)
      export AWS_ENDPOINT_URL="$LOCALSTACK_ENDPOINT"
      export AWS_ACCESS_KEY_ID=test
      export AWS_SECRET_ACCESS_KEY=test
      export AWS_REGION=ap-northeast-1
      export AWS_DEFAULT_REGION=ap-northeast-1
      unset AWS_PROFILE AWS_SESSION_TOKEN
      ;;
    dev) ;;
    *)
      echo "エラー: 未知のステージです: $1（local か dev）" >&2
      return 2
      ;;
  esac
}
