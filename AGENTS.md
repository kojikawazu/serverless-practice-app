# Codex instructions

このリポジトリでは `.claude/rules/` が開発ルールの唯一の正本です。作業を始める前に、変更対象に応じて次のルールを読み、守ってください。ルール本文をこのファイルへ複製しないでください。

## 常に適用するルール

- `.claude/rules/shortcuts.md`
- `.claude/rules/workflow.md`
- `.claude/rules/quality-gate.md`
- `.claude/rules/documentation.md`
- `.claude/rules/git.md`
- `.claude/rules/github-issue.md`
- `.claude/rules/testing.md`
- `.claude/rules/codex.md`
- `.claude/rules/lessons-learned.md`
- `.claude/rules/pr-description.md`
- `.claude/rules/static-analysis.md`

## スタック別ルール

`.claude/rules/` に追加されたスタック別ルールは、その front matter の `globs` が変更対象に一致する場合に追加で読み、守ってください。`/rules-update` 実行後は、同スキルが `AGENTS.md` のルール一覧を同期します。

## ルール構成を変更するとき

`.claude/rules/` の本文が唯一の正本です。ルールファイルの追加・削除・改名・適用範囲変更時は、同一変更で `CLAUDE.md`、該当する `AGENTS.md`、README の AI エージェント向けルールを同期してください。ルール本文だけの変更では、各入口ファイルを更新する必要はありません。
