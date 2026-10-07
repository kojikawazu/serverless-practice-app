---
description: GitHub issue 運用（ブランチと対で issue を作成し open/close で進捗管理）
globs: 
---

# GitHub issue 運用

開発の作業単位を GitHub issue で管理する。

- **issue 起票**: 開発を開始する際、作業ブランチを切るのと対で、対応する GitHub issue を作成する（作業単位 = 1 issue）。
- **起票前の重複確認**: 起票する前に `gh issue list --state open` で既存の issue を確認し、親 issue があればそのサブ issue も確認する。重なる issue があれば新規に起票せず、そちらへ追記する。重複した issue は、どちらで議論・完了したかが分からなくなり、片方が閉じられないまま残り続ける。
- **進捗管理**: issue の状態で進捗を表す。
  - **対応中**: issue は open のままにする。
  - **完了**: 対応する PR のマージで issue をクローズする（下記の自動クローズを使う）。
- **ブランチとの紐付け**: ブランチ名は GitHub Flow の命名規約（feat/*, fix/*, chore/* 等）に従い、対応する issue を PR で参照する。
- **PR での自動クローズ**: PR 本文に `Closes #<issue番号>`（バグ修正は `Fixes #<issue番号>`）を記載し、マージ時に issue を自動クローズする。
- **粒度**: 1 issue = 1 PR で閉じられるまとまった作業を基本とする。
- **サブ issue（作業を分割する場合）**: 作業が大きく大枠・中枠・小枠に分かれる場合は、大枠を親 issue、中枠・小枠をサブ issue として起票する。
  - **進捗の集約には GitHub のサブ issue 機能を使う**（下記「サブ issue の張り方」）。親子リンクを張れば進捗が自動集計される。
  - 各サブ issue も通常どおりブランチ・PR と対応させ、PR の `Closes #<サブissue番号>` でクローズする。全サブ issue が閉じたら親 issue を閉じる。
  - 分割が不要な小さい作業は単一 issue でよい（無理に親子化しない）。

## サブ issue の張り方

**親 issue の本文に手書きのチェックリスト（`- [ ] #<番号>`）を置かない。** `Closes #<番号>` で子 issue は自動クローズされるが、**親本文のチェックボックスは誰も更新しない**ため、実態とずれ続ける。「更新し忘れたらずれる」構造を作らず、GitHub に集計させる。

```bash
# 親 issue に子 issue を紐付ける
gh api --method POST repos/<owner>/<repo>/issues/<親issue番号>/sub_issues \
  -F sub_issue_id="$(gh api repos/<owner>/<repo>/issues/<子issue番号> --jq .id)"

# 確認（進捗の分母・分子になる）
gh api repos/<owner>/<repo>/issues/<親issue番号>/sub_issues --jq '.[] | "#\(.number) \(.state)"'
```

- **`sub_issue_id` は issue 番号ではなく内部 id**（例: `#82` → `5024698109`）。番号をそのまま渡すと別の issue が紐付くか 404 になるため、必ず `--jq .id` で引く。
- 一括で張ったら、**件数を突き合わせて検証する**。取りこぼしはエラーにならず「進捗が少なく見える」形でしか現れないため気づきにくい。
- **優先度・深刻度・着手順など、サブ issue 機能で表現できない情報だけを親 issue の本文に書く**（進捗と二重管理にしない）。
- **例外**: サブ issue 機能が使えない環境に限り、フォールバックとしてチェックリストを使ってよい。その場合は**マージのたびに親を手で更新する**必要があり、更新漏れでずれることを承知のうえで使う。
