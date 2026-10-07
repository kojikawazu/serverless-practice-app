#!/usr/bin/env bash
# 鍵・.env などの秘匿ファイルが Git 管理下に入っていないことを検証する。
# CI（.github/workflows/secret-scan.yml）とローカルが同じこのスクリプトを実行する。
# 検出パターンを 2 箇所に書き写さないための一元化。
# 手順を CI とローカルに書き分けると、必ずどちらかが腐る。
#
# タスクランナー（package.json / Makefile 等）がある場合は、そのターゲットから
# 本スクリプトを呼ぶ。コマンドを書き写さない。
#
# .gitignore は「未追跡ファイルを追跡させない」側の対策でしかない。一度追跡された
# ファイルには効かず、git add -f や書き漏れも止められない。本スクリプトは
# 「追跡された時点で落とす」検出側を担う。
#
# 対象は「git が見ているファイル」（追跡済み + 未追跡。.gitignore 対象は除く）。
# --others を含めるのは、.gitignore に書き忘れた .env をコミット前に手元で捕まえるため。
# CI では全てコミット済みなので結果は変わらない。
#
# 使い方:
#   scripts/check-secret-files.sh            追跡中 + 未追跡のファイルを検査（CI はこれ）
#   scripts/check-secret-files.sh --history  履歴上の全パスを検査（導入時に一度だけ）
#
# 既定では履歴を走査しない。git ls-files はインデックスを読むだけなので数秒で終わり、
# パスフィルタで分岐させずに常時実行できる。その代わり導入前に混入したものは
# 見つからないため、導入時に --history で一度だけ履歴を照合する。検出パターンを
# 別のコマンドへ書き写さないよう、同じスクリプトのオプションで切り替える。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 検出するパス（末尾一致）。鍵・証明書・認証情報・環境変数ファイル。
SECRET_PATTERN='(^|/)(\.env(\..+)?|[^/]+\.(key|pem|p12|pfx|jks|keystore)|id_rsa|id_ed25519|id_dsa|credentials\.json|serviceAccountKey\.json)$'
# 誤検知になるテンプレートと型定義は除外する。正当な理由で上記に当たるファイルを
# 管理したい場合は、ここへ理由をコメントで添えて足す（ファイル単位で最小に絞る）。
ALLOW_PATTERN='\.(example|sample|template|dist)$|\.env\.d\.ts$'

# git 管理外では「何が追跡されているか」がそもそも定義できない。ここで git ls-files を
# そのまま使うと、失敗がプロセス置換の中に閉じて set -e に捕まらず、対象 0 件の
# 「問題なし」として静かに終わる。黙って検査を飛ばさない。
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "git 管理下ではないため検査できません（git init 後に実行してください）。" >&2
  exit 1
fi

# 日本語などのパスを "\346..." と引用符付きでエスケープさせない（末尾一致が効かなくなる）
git_paths() { git -c core.quotePath=false "$@"; }
# 検出したパスを字下げして並べる
indent() { while IFS= read -r line; do printf '  %s\n' "$line"; done <<< "$1"; }

if [ "${1:-}" = "--history" ]; then
  # 各コミットで追加されたパスを全て引く。git rev-list --objects は blob 単位で重複を
  # 除くため、内容が同じファイル（.env と .env.example が同一など）は片方の名前しか
  # 出ず取りこぼす。--no-renames はリネームを「追加」として数えるため。
  history_hits="$(git_paths log --all --no-renames --diff-filter=A --name-only --pretty=format: | sort -u \
    | grep -E "$SECRET_PATTERN" | grep -vE "$ALLOW_PATTERN" || true)"
  if [ -n "$history_hits" ]; then
    echo "::error::履歴上に秘匿ファイルのパスがあります。"
    indent "$history_hits"
    echo "  追跡から外しても履歴には残る。含まれていた鍵・トークンをローテーションする。"
    exit 1
  fi
  echo "OK: 履歴上に秘匿ファイルのパスはありません"
  exit 0
elif [ "$#" -gt 0 ]; then
  echo "不明な引数: $1（使えるのは --history のみ）" >&2
  exit 2
fi

tracked="$(git_paths ls-files --cached | grep -E "$SECRET_PATTERN" | grep -vE "$ALLOW_PATTERN" || true)"
untracked="$(git_paths ls-files --others --exclude-standard | grep -E "$SECRET_PATTERN" | grep -vE "$ALLOW_PATTERN" || true)"

status=0

if [ -n "$tracked" ]; then
  echo "::error::秘匿ファイルが Git 管理下にあります。"
  indent "$tracked"
  echo "  git rm --cached で追跡から外し、.gitignore に追加する。"
  echo "  push 済みなら履歴に残っているため、鍵・トークンのローテーションが必要。"
  status=1
fi

if [ -n "$untracked" ]; then
  echo "::error::.gitignore されていない秘匿ファイルがあります（git add すると混入します）。"
  indent "$untracked"
  echo "  .gitignore に追加する。"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: 追跡対象・追跡候補に秘匿ファイルはありません"
fi
exit "$status"
