#!/usr/bin/env bash
# Terraform の state を置くバケットを作り、.claude/rules/iac.md が求める設定にそろえる（dev 用）。
# state バケットは Terraform では管理しない（自分の state を置くバケットを自分で作れないため。docs/09「Terraform の state」）。
# README と dev の手順からはこのスクリプトを呼ぶだけにする（.claude/rules/duplication.md）。
#
# 使い方:
#   scripts/tfstate-bucket.sh <stage>           ずれている設定だけを直す（何度実行しても同じ結果になる）
#   scripts/tfstate-bucket.sh <stage> --check   直さずに比べるだけ。ずれがあれば終了コード 1
#
# stage: dev は実 AWS（手元のプロファイルで認証する）。local は LocalStack で、このスクリプトの検証用。
# dev では、直す前に確認のプロンプトを出す（実 AWS の設定を、確認なしで変えない）。
#
# 終了コード: 0 = そろっている（直してそろった場合を含む）
#             1 = ずれがある（--check）・直しても揃わない・判定できない（読めない設定・他のアカウントのバケット）
#             2 = 使い方の誤り
#
# 環境変数:
#   TFSTATE_BUCKET   local でだけ、バケット名を差し替える（IT が使い捨てのバケットで試すため）。
#                    dev では無視する（backend の定義と違うバケットを作らせない）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/aws-stage.sh
source "${REPO_ROOT}/scripts/lib/aws-stage.sh"

# 古い版を消すまでの日数と、日数に関わらず残す新しい版の数（iac.md「直近の履歴は残す条件」）
NONCURRENT_DAYS=90
NEWER_NONCURRENT_VERSIONS=10
# 途中で止まったマルチパートアップロードを消すまでの日数
ABORT_MULTIPART_DAYS=7

ITEMS=(versioning public-access ownership encryption policy lifecycle)

usage() {
  echo "使い方: $0 {local|dev} [--check]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
stage="$1"
check=false
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--check" ]] || usage
  check=true
fi
case "$stage" in
  local | dev) ;;
  *) usage ;;
esac
use_stage_aws "$stage"

# backend の定義（infra/terraform/versions.tf）から値を読む。バケット名・リージョンを書き写さない
backend_value() {
  local values
  values="$(sed -n "/backend \"s3\"/,/}/s/^ *$1 *= *\"\(.*\)\"/\1/p" "${REPO_ROOT}/infra/terraform/versions.tf")"
  if [[ -z "$values" || "$values" == *$'\n'* ]]; then
    echo "エラー: infra/terraform/versions.tf の backend \"s3\" から $1 を 1 つに特定できません" >&2
    return 1
  fi
  printf '%s' "$values"
}

BUCKET="$(backend_value bucket)"
REGION="$(backend_value region)"
if [[ "$stage" == local ]]; then
  BUCKET="${TFSTATE_BUCKET:-$BUCKET}"
fi
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

s3api() {
  aws s3api --region "$REGION" "$@"
}

# あるべき設定。put 系の API にそのまま渡す形で書き、比較も同じ形にそろえて行う
DESIRED_PUBLIC_ACCESS='{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'
DESIRED_OWNERSHIP='{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
DESIRED_ENCRYPTION='{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
# HTTPS 以外のアクセスを拒否する（.claude/rules/security.md「通信」）
DESIRED_POLICY="$(
  cat <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*",
"Resource":["arn:aws:s3:::${BUCKET}","arn:aws:s3:::${BUCKET}/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
EOF
)"
DESIRED_LIFECYCLE="$(
  cat <<EOF
{"Rules":[{"ID":"tfstate-retention","Status":"Enabled","Filter":{"Prefix":""},
"NoncurrentVersionExpiration":{"NoncurrentDays":${NONCURRENT_DAYS},"NewerNoncurrentVersions":${NEWER_NONCURRENT_VERSIONS}},
"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":${ABORT_MULTIPART_DAYS}}}]}
EOF
)"

# 設定（JSON）を、比較に使う形に正規化する。読んだ設定とあるべき設定の両方を通し、文字列で比べる。
# AWS が返す付帯情報（既定値の補完・キーの順序）でずれと誤判定しないよう、このスクリプトが決める項目だけを取り出す
normalize() {
  python3 -c '
import json, sys
item = sys.argv[1]
config = json.load(sys.stdin)
if item == "public-access":
    keys = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]
    out = {key: config.get(key) for key in keys}
elif item == "ownership":
    out = [rule.get("ObjectOwnership") for rule in config.get("Rules", [])]
elif item == "encryption":
    out = [rule.get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm") for rule in config.get("Rules", [])]
elif item == "policy":
    out = config
elif item == "lifecycle":
    out = [
        {
            "ID": rule.get("ID"),
            "Status": rule.get("Status"),
            "Prefix": rule.get("Filter", {}).get("Prefix", rule.get("Prefix", "")),
            "NoncurrentVersionExpiration": rule.get("NoncurrentVersionExpiration"),
            "AbortIncompleteMultipartUpload": rule.get("AbortIncompleteMultipartUpload"),
            "Expiration": rule.get("Expiration"),
            "Transitions": rule.get("Transitions"),
        }
        for rule in config.get("Rules", [])
    ]
else:
    sys.exit("未知の項目: " + item)
print(json.dumps(out, sort_keys=True, separators=(",", ":")))
' "$1"
}

# 設定を読む。設定が無いことを示すエラーコード（$1。無い API は空にする）なら「未設定」を出す。
# それ以外のエラー（権限不足・通信の失敗）は判定できないため、「未設定」に丸めずに止める
read_config() {
  local not_set="$1" err out
  shift
  err="$(mktemp)"
  if out="$(s3api "$@" --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --output json 2>"$err")"; then
    rm -f "$err"
    printf '%s' "$out"
    return 0
  fi
  if [[ -n "$not_set" ]] && grep -q "(${not_set})" "$err"; then
    rm -f "$err"
    printf '未設定'
    return 0
  fi
  cat "$err" >&2
  rm -f "$err"
  echo "エラー: ${BUCKET} の設定を読めませんでした（$1）" >&2
  return 1
}

# 項目の現在の設定を、比較に使う形で出す
current() {
  local raw
  case "$1" in
    versioning)
      # 一度も有効にしていないバケットは、エラーではなく空の応答を返す
      raw="$(read_config "" get-bucket-versioning)" || return 1
      [[ -n "$raw" ]] || raw='{}'
      python3 -c 'import json, sys; print(json.load(sys.stdin).get("Status", "未設定"), end="")' <<<"$raw"
      return 0
      ;;
    public-access)
      raw="$(read_config NoSuchPublicAccessBlockConfiguration get-public-access-block)" || return 1
      [[ "$raw" == 未設定 ]] || raw="$(python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["PublicAccessBlockConfiguration"]))' <<<"$raw")"
      ;;
    ownership)
      raw="$(read_config OwnershipControlsNotFoundError get-bucket-ownership-controls)" || return 1
      [[ "$raw" == 未設定 ]] || raw="$(python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["OwnershipControls"]))' <<<"$raw")"
      ;;
    encryption)
      raw="$(read_config ServerSideEncryptionConfigurationNotFoundError get-bucket-encryption)" || return 1
      [[ "$raw" == 未設定 ]] || raw="$(python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["ServerSideEncryptionConfiguration"]))' <<<"$raw")"
      ;;
    policy)
      raw="$(read_config NoSuchBucketPolicy get-bucket-policy)" || return 1
      # ポリシーは JSON の文字列として返る
      [[ "$raw" == 未設定 ]] || raw="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["Policy"])' <<<"$raw")"
      ;;
    lifecycle)
      raw="$(read_config NoSuchLifecycleConfiguration get-bucket-lifecycle-configuration)" || return 1
      ;;
  esac
  if [[ "$raw" == 未設定 ]]; then
    printf '未設定'
  else
    normalize "$1" <<<"$raw"
  fi
}

# 項目のあるべき設定を、比較に使う形で出す
desired() {
  case "$1" in
    versioning) printf 'Enabled' ;;
    public-access) normalize "$1" <<<"$DESIRED_PUBLIC_ACCESS" ;;
    ownership) normalize "$1" <<<"$DESIRED_OWNERSHIP" ;;
    encryption) normalize "$1" <<<"$DESIRED_ENCRYPTION" ;;
    policy) normalize "$1" <<<"$DESIRED_POLICY" ;;
    lifecycle) normalize "$1" <<<"$DESIRED_LIFECYCLE" ;;
  esac
}

# 項目をあるべき設定にする
apply() {
  local owner=(--bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT_ID")
  case "$1" in
    versioning) s3api put-bucket-versioning "${owner[@]}" --versioning-configuration Status=Enabled ;;
    public-access) s3api put-public-access-block "${owner[@]}" --public-access-block-configuration "$DESIRED_PUBLIC_ACCESS" ;;
    ownership) s3api put-bucket-ownership-controls "${owner[@]}" --ownership-controls "$DESIRED_OWNERSHIP" ;;
    encryption) s3api put-bucket-encryption "${owner[@]}" --server-side-encryption-configuration "$DESIRED_ENCRYPTION" ;;
    policy) s3api put-bucket-policy "${owner[@]}" --policy "$DESIRED_POLICY" ;;
    lifecycle) s3api put-bucket-lifecycle-configuration "${owner[@]}" --lifecycle-configuration "$DESIRED_LIFECYCLE" ;;
  esac
}

label() {
  case "$1" in
    bucket) printf 'バケット' ;;
    versioning) printf 'バージョニング' ;;
    public-access) printf '公開アクセスのブロック' ;;
    ownership) printf 'オブジェクトの所有者（ACL 無効）' ;;
    encryption) printf '暗号化' ;;
    policy) printf 'バケットポリシー（HTTPS のみ）' ;;
    lifecycle) printf 'ライフサイクル（古い版の削除）' ;;
  esac
}

# バケットがあるかを調べる。自分のアカウントのものなら 0、無ければ 3。
# 他のアカウントが持つ名前（403）や、別のリージョンにあるものは、そこへ state を書かせないよう止める
bucket_exists() {
  local err region
  err="$(mktemp)"
  if s3api head-bucket --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT_ID" >/dev/null 2>"$err"; then
    rm -f "$err"
    region="$(s3api get-bucket-location --bucket "$BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --query LocationConstraint --output text)"
    if [[ "$region" != "$REGION" ]]; then
      echo "エラー: バケット ${BUCKET} は ${region} にあります（backend の定義は ${REGION}）" >&2
      return 1
    fi
    return 0
  fi
  if grep -q "(404)" "$err"; then
    rm -f "$err"
    return 3
  fi
  cat "$err" >&2
  rm -f "$err"
  echo "エラー: バケット ${BUCKET} はアカウント ${ACCOUNT_ID} のものとして確認できません（他のアカウントが持つ名前か、権限が足りません）" >&2
  return 1
}

echo "バケット ${BUCKET}（${REGION}、アカウント ${ACCOUNT_ID}、ステージ ${stage}）"

# 1. 比べて、ずれている項目を集める
drift=()
exists=true
rc=0
bucket_exists || rc=$?
case "$rc" in
  0) printf '  %s: ある\n' "$(label bucket)" ;;
  3)
    exists=false
    printf '  %s: 無い\n' "$(label bucket)"
    drift=(bucket "${ITEMS[@]}")
    ;;
  *) exit 1 ;;
esac

if [[ "$exists" == true ]]; then
  for item in "${ITEMS[@]}"; do
    now="$(current "$item")"
    want="$(desired "$item")"
    if [[ "$now" == "$want" ]]; then
      printf '  %s: 変更なし\n' "$(label "$item")"
    else
      printf '  %s: ずれがあります\n    現在: %s\n    期待: %s\n' "$(label "$item")" "$now" "$want"
      drift+=("$item")
    fi
  done
fi

if [[ ${#drift[@]} -eq 0 ]]; then
  echo "すべての設定がそろっています"
  exit 0
fi
if [[ "$check" == true ]]; then
  echo "ずれがある項目: ${#drift[@]} 件（直すには --check を付けずに実行してください）" >&2
  exit 1
fi

# 2. dev では、直す前に確認する
if [[ "$stage" == dev ]]; then
  read -r -p "上の ${#drift[@]} 項目を、アカウント ${ACCOUNT_ID} で直します。よろしいですか？ [y/N] " answer
  if [[ "$answer" != y ]]; then
    echo "中止しました" >&2
    exit 1
  fi
fi

# 3. ずれている項目だけを直す
for item in "${drift[@]}"; do
  if [[ "$item" == bucket ]]; then
    s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  else
    # put 系の一部（ライフサイクル）は応答を出力するため捨てる
    apply "$item" >/dev/null
  fi
  printf '  %s: 設定しました\n' "$(label "$item")"
done

# 4. 直した結果を読み直し、そろったことを確かめる（API が成功を返しても、反映を確認するまで成功としない）
for item in "${ITEMS[@]}"; do
  if [[ "$(current "$item")" != "$(desired "$item")" ]]; then
    echo "エラー: $(label "$item") を設定しましたが、読み直すとそろっていません" >&2
    exit 1
  fi
done
echo "すべての設定がそろいました"
