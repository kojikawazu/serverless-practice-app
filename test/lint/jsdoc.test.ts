import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// JSDoc 必須ルールの検出結果を fixture の印と突き合わせる回帰テスト（jsdoc.md「検出結果を回帰テストに固定する」）。
// プラグインやセレクタの更新で検出が黙って変わったら落とす。検出漏れだけでなく、余計な検出も落とす。

const FIXTURE = fileURLToPath(
  new URL("./fixtures/jsdoc-targets.ts", import.meta.url),
);
const MARKER = "expect-jsdoc";
const RULE = "jsdoc/require-jsdoc";

/**
 * fixture の印から、検出されるべき宣言の行番号（1 始まり）を集める。印は宣言の直前の行に置く。
 *
 * @param source - fixture の本文
 * @returns 検出されるべき行番号の昇順リスト
 */
function markedLines(source: string): number[] {
  return source
    .split("\n")
    .flatMap((line, index) =>
      line.trim() === `// ${MARKER}` ? [index + 2] : [],
    );
}

/**
 * リポジトリの ESLint 設定で fixture を検査し、JSDoc 必須ルールが報告した行番号を集める。
 *
 * @returns 報告された行番号の昇順リスト
 */
async function reportedLines(): Promise<number[]> {
  // fixture は通常の Lint から ignores で外しているため、ignore: false で明示的に検査する。
  // ルールの設定（セレクタ・オプション）はリポジトリの eslint.config.js をそのまま使い、次の 2 点だけ変える:
  // - 動かすルールを JSDoc 必須ルールに絞る（ruleFilter）
  // - 型情報の読み込み（projectService）を切る。JSDoc のルールは型を使わない一方、型情報を読むと
  //   tsconfig の対象全体（aws-cdk-lib の型定義を含む）でプログラムを組み立てるため、CI で 30 秒を超えた
  const eslint = new ESLint({
    ignore: false,
    ruleFilter: ({ ruleId }) => ruleId === RULE,
    overrideConfig: {
      languageOptions: { parserOptions: { projectService: false } },
    },
  });
  const [result] = await eslint.lintFiles([FIXTURE]);
  if (result === undefined) {
    throw new Error(`ESLint が fixture を検査しなかった: ${FIXTURE}`);
  }
  return result.messages
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.line)
    .sort((a, b) => a - b);
}

describe("JSDoc 必須ルールの検出対象", () => {
  it("fixture に印が付いている（印が 0 件のまま緑にならない）", async () => {
    const lines = markedLines(await readFile(FIXTURE, "utf8"));

    expect(lines.length).toBeGreaterThanOrEqual(8);
  });

  it("印の付いた行と、ルールが報告した行が過不足なく一致する", async () => {
    const expected = markedLines(await readFile(FIXTURE, "utf8"));

    const actual = await reportedLines();

    expect(actual).toEqual(expected);
  }, 30_000);
});
