# コードリーディング: functions

## 対象

- モード: モードB（機能・モジュール単位）
- 対象範囲: `functions/src/`（handlers・lib・schemas・types・errors・stubs の 23 ファイル）。テスト（`functions/test/`）は検証の仕方を知るための参照に留める
- スタック: TypeScript（Node.js 22・ESM）・Zod 4・AWS SDK for JavaScript v3。バンドルは CDK の `NodejsFunction`（esbuild）
- 読解日: 2026-11-08

> 本ドキュメントは読解時点のコードに対する理解の記録である。コード変更に追従して更新すること。

仕様の決定（各 Lambda が何をすべきか・入出力の形・タイムアウトやリトライの値）は 03・04・05・07 が正本で、本書は「コードがそれをどう実装しているか」を追う。AWS の各サービスの仕組みは [技術の解説](../../README.md#技術の解説guides)を参照。

## 目次

| # | ファイル | 内容 |
|---|---------|------|
| 01 | [01-overview.md](./01-overview.md) | 概要・エントリポイント |
| 02 | [02-flow.md](./02-flow.md) | 処理フロー（シーケンス図・呼び出し連鎖） |
| 03 | [03-modules.md](./03-modules.md) | 主要モジュール・責務・依存関係 |
| 04 | [04-data.md](./04-data.md) | データフロー・主要な型/データ構造・注意点 |

## 読む順のおすすめ

1. [01](./01-overview.md) で 4 つの Lambda の入口と、全 handler に共通する形（入口と本体の分離）を掴む
2. [03](./03-modules.md) で層（handlers → lib / schemas → types / errors / stubs）と依存の向きを確かめる
3. [02](./02-flow.md) で気になる Lambda の流れを追う。失敗の返し方が Lambda ごとに違う点に注意する
4. [04](./04-data.md) の「読解上の注意点」で、コードだけでは気づきにくい前提を確かめる
