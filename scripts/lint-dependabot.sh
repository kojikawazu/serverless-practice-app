#!/usr/bin/env bash
# .github/dependabot.yml を Dependabot のスキーマで検査する。
# CI（.github/workflows/dependabot-config.yml）とローカルが同じこのスクリプトを実行する。
# コマンド文字列とバージョンを 2 箇所に書き写さないための一元化。
#
# dependabot.yml の誤りは actionlint の対象外で、GitHub もマージ後に
# Insights → Dependency graph → Dependabot に出すだけ。誤った設定をマージしても CI は緑のままで、
# 更新が黙って止まる。それをマージ前に落とすための検査（#38）。
#
# 使い方:
#   scripts/lint-dependabot.sh              .github/dependabot.yml を検査
#   scripts/lint-dependabot.sh path/to.yml  指定したファイルを検査（壊したコピーで検査が落ちることを確かめる用）
#
# スキーマは check-jsonschema に同梱のもの（vendor.dependabot）を使う。ツールの版を固定すれば
# スキーマも固定される。外から毎回取得すると、何も変えていないのにスキーマの更新で CI が落ちる。
# 更新は依存更新として明示的に行う（Dependabot は run: 内のバージョンを更新しない）。
set -euo pipefail

CHECK_JSONSCHEMA_VERSION="0.38.2"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

target="${1:-.github/dependabot.yml}"

# 対象が無いのを「検査して問題なし」にしない
if [ ! -f "$target" ]; then
  echo "error: 検査対象がありません: $target" >&2
  exit 1
fi

# pipx は GitHub Actions の ubuntu ランナーに入っている。無い環境で黙って検査を飛ばさない
if ! command -v pipx >/dev/null 2>&1; then
  echo "error: pipx が見つかりません（brew install pipx / apt install pipx）" >&2
  exit 1
fi

exec pipx run --spec "check-jsonschema==${CHECK_JSONSCHEMA_VERSION}" \
  check-jsonschema --builtin-schema vendor.dependabot "$target"
