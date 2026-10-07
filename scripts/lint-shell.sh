#!/usr/bin/env bash
# リポジトリ内のシェルスクリプトを shellcheck で検査する。
# CI（.github/workflows/shellcheck.yml）とローカルが同じこのスクリプトを実行する。
# コマンド文字列とバージョンを 2 箇所に書き写さないための一元化。
# 手順を CI とローカルに書き分けると、必ずどちらかが腐る。
#
# タスクランナー（package.json / Makefile 等）がある場合は、そのターゲットから
# 本スクリプトを呼ぶ。コマンドを書き写さない。
#
# 使い方:
#   scripts/lint-shell.sh              追跡中の *.sh をすべて検査
#   scripts/lint-shell.sh path/to.sh   指定したファイルだけ検査
#
# 対象は「git が見ている *.sh」（追跡済み + 未追跡。.gitignore 対象は除く）。
# ディレクトリの対象リストを持たず git から引くので、新しい場所にスクリプトを足しても
# 検査から漏れない。対象リストで書くと、ディレクトリが増えたときに黙って検査されなく
# なる（安全側に倒す）。
# --others を付けるのは、コミット前の新規スクリプトを手元で検査するため。これが無いと
# CI では全てコミット済みなので通り、手元でだけ新規ファイルが無検査になる。
#
# バージョンは固定する。latest にすると、スクリプトを 1 文字も変えていないのに
# 新リリースの検査強化で CI が落ちる（actionlint など他の検査ツールと同じ理由）。
# 更新は依存更新として明示的に行う。
#
# 実行系は「手元の shellcheck（バージョン一致時のみ）→ 固定タグの Docker」の順に選ぶ。
# actionlint を公式 Docker イメージで動かすのは「バイナリ版が shellcheck を同梱しない」
# ためであり、shellcheck 自体にはその理由が無いので Docker を必須にしない。ただし
# バージョンの違うものを黙って使うと「手元で通ったのに CI で落ちる」を招くため、
# 一致しなければ Docker へ倒す。両方使えない場合は、黙って検査を飛ばさずエラーで止める。
#
# 抑制（# shellcheck disable=SCxxxx）は該当行のみに絞り、理由をコメントで書く
# （.claude/rules/static-analysis.md「抑制コメントの扱い」）。
set -euo pipefail

SHELLCHECK_VERSION="0.11.0"
SHELLCHECK_IMAGE="koalaman/shellcheck:v${SHELLCHECK_VERSION}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 検査対象を決める。引数があればそれを、無ければ追跡中の *.sh を使う。
# macOS 標準の bash 3.2 には mapfile / readarray が無いため read ループで積む。
targets=()
if [ "$#" -gt 0 ]; then
  targets=("$@")
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r f; do
    targets+=("$f")
  done < <(git ls-files --cached --others --exclude-standard -- '*.sh' | sort -u)
else
  # git 管理下でない場合（git init 前など）は find で拾う。ここで git ls-files を
  # そのまま使うと、失敗がプロセス置換の中に閉じて set -e に捕まらず、対象 0 件の
  # 「検査するものがありません」として静かに終わる。黙って検査を飛ばさない。
  while IFS= read -r f; do
    targets+=("$f")
  done < <(find . -type f -name '*.sh' \
    -not -path './.git/*' \
    -not -path './node_modules/*' \
    -not -path './vendor/*' | sed 's|^\./||' | sort -u)
fi

# 対象ゼロで shellcheck を起動しない。引数なしの shellcheck は標準入力を待つため、
# CI がハングするか、紛らわしいエラーで落ちる。
if [ "${#targets[@]}" -eq 0 ]; then
  echo "検査対象の .sh がありません。"
  exit 0
fi

installed_version=""
if command -v shellcheck >/dev/null 2>&1; then
  installed_version="$(shellcheck --version | awk '/^version:/ { print $2 }')"
fi

if [ "$installed_version" = "$SHELLCHECK_VERSION" ]; then
  exec shellcheck "${targets[@]}"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "shellcheck ${SHELLCHECK_VERSION} が見つからず、Docker も使えません。" >&2
  if [ -n "$installed_version" ]; then
    echo "  手元の shellcheck: ${installed_version}（固定バージョン ${SHELLCHECK_VERSION} と不一致）" >&2
  fi
  echo "  対処: shellcheck ${SHELLCHECK_VERSION} を入れるか、Docker を起動する。" >&2
  exit 1
fi

exec docker run --rm -v "${REPO_ROOT}:/mnt" -w /mnt "$SHELLCHECK_IMAGE" "${targets[@]}"
