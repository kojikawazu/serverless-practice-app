// scripts/cdk.sh のテストで、PATH の先頭に置く偽の npx（test/scripts/cdk.test.ts）。
// cdk.sh は `npx --no-install <cdk|cdklocal> ...` で CDK の CLI を呼ぶ。差分の出方（置換の有無・方法による違い・失敗）を
// 思いどおりに作るため、外部 I/O の CLI だけをこれに差し替える（.claude/rules/testing.md）。
// Node の型除去（--experimental-strip-types）でそのまま動かすため、型の注釈以外の TypeScript 固有の構文を使わない。
//
// 環境変数:
//   FAKE_CDK_DIR   `diff` の応答を置くディレクトリ。`<method>.out`（出力）と `<method>.code`（終了コード）を読む。
//                  ファイルが無ければ「差分なし」の出力と終了コード 0 を返す
//   FAKE_CDK_LOG   呼び出しの引数を 1 行 1 JSON で追記するファイル
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** 応答のファイルが無いときに返す、差分の無い出力（cdk diff の末尾の要約の形） */
const NO_DIFFERENCE_OUTPUT = "✨  Number of stacks with differences: 0\n";

const dir = process.env["FAKE_CDK_DIR"];
const logPath = process.env["FAKE_CDK_LOG"];
if (dir === undefined || logPath === undefined) {
  process.stderr.write(
    "fake-npx-cdk: FAKE_CDK_DIR と FAKE_CDK_LOG が要ります\n",
  );
  process.exit(255);
}

const args = process.argv.slice(2);
appendFileSync(logPath, `${JSON.stringify(args)}\n`);

// diff 以外（bootstrap / deploy / destroy）は、呼ばれたことの記録だけで足りる
if (!args.includes("diff")) {
  process.exit(0);
}

const methodArg = args.find((arg) => arg.startsWith("--method="));
const method =
  methodArg === undefined ? "auto" : methodArg.slice("--method=".length);
const outPath = path.join(dir, `${method}.out`);
const codePath = path.join(dir, `${method}.code`);
const output = existsSync(outPath)
  ? readFileSync(outPath, "utf8")
  : NO_DIFFERENCE_OUTPUT;
const code = existsSync(codePath)
  ? Number(readFileSync(codePath, "utf8").trim())
  : 0;
// cdk.sh は標準出力と標準エラー出力の両方を受け取る。標準出力より取りこぼしやすい標準エラー出力に書き、それでも読めることを確かめる
process.stderr.write(output);
process.exit(code);
