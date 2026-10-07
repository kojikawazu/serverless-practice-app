#!/usr/bin/env bash
# リポジトリ内の Markdown を markdownlint-cli2 で検査する。
# CI（.github/workflows/markdownlint.yml）とローカルが同じこのスクリプトを実行する。
# コマンド文字列とバージョンを 2 箇所に書き写さないための一元化。
# 手順を CI とローカルに書き分けると、必ずどちらかが腐る。
#
# タスクランナー（package.json / Makefile 等）がある場合は、そのターゲットから
# 本スクリプトを呼ぶ。コマンドを書き写さない。
#
# 使い方:
#   scripts/lint-docs.sh          検査のみ（違反があれば終了コード 1）
#   scripts/lint-docs.sh --fix    自動修正できるものを直してから検査
#
# 対象・除外・有効ルールは .markdownlint-cli2.jsonc が唯一の真実。
# 引数なしで呼ぶと markdownlint-cli2 がそのファイルの globs を読む。
#
# --fix を一括適用したら、コミット前に必ず差分を読む。自動修正は構文上の推測で
# 本文を書き換えるため、意味を壊すことがある（.claude/rules/static-analysis.md）。
#
# バージョンは固定する。latest にすると、Markdown を 1 文字も変えていないのに
# 新リリースの検査強化で CI が落ちる（actionlint など他の検査ツールと同じ理由）。
# 更新は依存更新として明示的に行う。
set -euo pipefail

MARKDOWNLINT_CLI2_VERSION="0.23.1"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

exec npx --yes "markdownlint-cli2@${MARKDOWNLINT_CLI2_VERSION}" "$@"
