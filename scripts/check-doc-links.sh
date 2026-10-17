#!/usr/bin/env bash
# Markdown の相対リンクの、リンク先（ファイル・ディレクトリ）と見出しの実在を確かめる。
# markdownlint の MD051 は同じファイルの中の見出ししか確かめず、ファイルをまたぐリンクは見出しの改名で黙って切れる。
# docs は正本を複製せず見出しへのリンクで参照する方針のため、この検査で切れたリンクを止める（#87）。
# CI（.github/workflows/markdownlint.yml）とローカルが同じこのスクリプトを実行する。
#
# 使い方:
#   scripts/check-doc-links.sh   git が見ている *.md をすべて検査
#
# 対象は「git が見ている *.md」（追跡済み + 未追跡。.gitignore 対象は除く）。lint-shell.sh と同じく、
# ディレクトリの対象リストを持たない。--others を付けるのは、コミット前の新しいファイルを手元で検査するため。
# 見出しの ID は GitHub と同じ規則（github-slugger）で作るため、先に npm ci が要る。
#
# 終了コード: 0 = すべて実在する、1 = 切れたリンクがある・対象が無い・git の外で実行した
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# git の外では「見ているファイル」が決まらない。0 件として通さずに止める
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "エラー: git のリポジトリの中で実行してください（検査する Markdown を git から引くため）" >&2
  exit 1
fi

# macOS 標準の bash 3.2 には mapfile / readarray が無いため read ループで積む。
# プロセス置換の中の失敗は set -e に捕まらないため、先に変数へ受けて終了コードを確かめる
listed="$(git ls-files --cached --others --exclude-standard -- '*.md')"
targets=()
while IFS= read -r f; do
  # 追跡したまま手元で消したファイルは、--cached に出るが読めない。検査は今あるファイルだけにする
  if [[ -n "$f" && -f "$f" ]]; then
    targets+=("$f")
  fi
done < <(printf '%s\n' "$listed" | sort -u)

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "エラー: 検査する Markdown のファイルがありません" >&2
  exit 1
fi

exec node --experimental-strip-types --no-warnings scripts/lib/doc-links.ts "${targets[@]}"
