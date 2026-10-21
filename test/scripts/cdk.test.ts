import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/cdk.sh の diff（デプロイ済みのスタックとの差分・置換の検出）を、偽の npx で確かめる（docs/08 #57〜#59）。
// 差分の出方（置換の有無・方法による違い・失敗）を思いどおりに作るため、外部 I/O の CDK の CLI だけを
// PATH の先頭の偽物に差し替える（testing.md）。LocalStack・実 AWS には触れない。

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CDK_SH = path.join(REPO_ROOT, "scripts/cdk.sh");
const FAKE_NPX = path.join(import.meta.dirname, "helpers/fake-npx-cdk.ts");

/** 置換を伴わない差分（2026-10-18 に cdklocal diff --method=template で見た出力の形） */
const UPDATE_OUTPUT = `Stack serverless-practice-app-local (aws://000000000000/ap-northeast-1)
Resources
[~] AWS::Scheduler::Schedule BatchSchedule BatchSchedule
 └─ [~] Target
     └─ [+] Added: .RetryPolicy
✨  Number of stacks with differences: 1
`;

/** 置換を伴う差分（2026-10-18 に cdklocal diff で見た出力の形）。項目の印とリソースの行の末尾の印の両方がある */
const REPLACEMENT_OUTPUT = `Stack serverless-practice-app-local (aws://000000000000/ap-northeast-1)
Resources
[~] AWS::StepFunctions::StateMachine BatchStateMachine BatchStateMachine35133ECB replace
 └─ [-] StateMachineType (requires replacement)
     └─ STANDARD
✨  Number of stacks with differences: 1
`;

/** 置換を伴う差分のうち、リソースの行の末尾の印だけがある出力（項目の印に頼らず検出できるかを確かめる） */
const REPLACE_SUFFIX_ONLY_OUTPUT = `Resources
[~] AWS::StepFunctions::StateMachine BatchStateMachine BatchStateMachine35133ECB replace
✨  Number of stacks with differences: 1
`;

/** 差分の無い出力 */
const NO_DIFFERENCE_OUTPUT =
  "There were no differences\n✨  Number of stacks with differences: 0\n";

/** 偽の CDK の CLI が、方法（`--method=` の値）ごとに返す応答 */
type FakeResponses = Partial<
  Record<"change-set" | "template", { output: string; code?: number }>
>;

/** スクリプトの実行結果 */
type RunResult = {
  /** 終了コード */
  code: number | null;
  /** 標準エラー出力（cdk.sh は案内と cdk の出力をここに書く） */
  stderr: string;
  /** 偽の npx が受け取った引数（呼ばれた順） */
  calls: string[][];
};

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "cdk-sh-"));
  mkdirSync(path.join(workDir, "bin"));
  mkdirSync(path.join(workDir, "responses"));
  writeFileSync(
    path.join(workDir, "bin/npx"),
    `#!/bin/sh\nexec node --experimental-strip-types --no-warnings "${FAKE_NPX}" "$@"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * cdk.sh を偽の npx で実行する。
 *
 * @param args - cdk.sh に渡す引数（`local diff` など）
 * @param responses - 方法ごとの応答。省略した方法は「差分なし」を返す
 * @returns 終了コード・標準エラー出力・呼び出しの記録
 */
function cdkSh(args: string[], responses: FakeResponses = {}): RunResult {
  const responsesDir = path.join(workDir, "responses");
  for (const [method, response] of Object.entries(responses)) {
    writeFileSync(path.join(responsesDir, `${method}.out`), response.output);
    writeFileSync(
      path.join(responsesDir, `${method}.code`),
      String(response.code ?? 0),
    );
  }
  const logPath = path.join(workDir, "calls.log");
  writeFileSync(logPath, "");
  const result = spawnSync("bash", [CDK_SH, ...args], {
    // 手元の AWS の設定（プロファイル・認証情報）を引き継がない
    env: {
      PATH: `${path.join(workDir, "bin")}:${process.env["PATH"] ?? ""}`,
      HOME: workDir,
      FAKE_CDK_DIR: responsesDir,
      FAKE_CDK_LOG: logPath,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    code: result.status,
    stderr: result.stderr,
    // 記録は偽の npx（fake-npx-cdk.ts）が書いたもので、形はこちらで決めている。検証せずに型を当てる
    calls: readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]),
  };
}

describe("cdk.sh diff", () => {
  describe("正常系", () => {
    it("local は cdklocal で、変更セットとテンプレートの 2 つの方法を明示して比べ、差分が無ければ 0 で終わる", () => {
      const result = cdkSh(["local", "diff"]);

      expect(result.code).toBe(0);
      expect(result.calls).toEqual([
        [
          "--no-install",
          "cdklocal",
          "diff",
          "-c",
          "stage=local",
          "--method=change-set",
          "--no-color",
        ],
        [
          "--no-install",
          "cdklocal",
          "diff",
          "-c",
          "stage=local",
          "--method=template",
          "--no-color",
        ],
      ]);
      expect(result.stderr).toContain(
        "差分のあるスタック: 変更セット 0 件・テンプレート 0 件",
      );
    });

    it("置換を伴わない差分だけなら、cdk の出力と件数を出して 0 で終わる", () => {
      const result = cdkSh(["local", "diff"], {
        "change-set": { output: UPDATE_OUTPUT },
        template: { output: UPDATE_OUTPUT },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("[+] Added: .RetryPolicy");
      expect(result.stderr).toContain(
        "差分のあるスタック: 変更セット 1 件・テンプレート 1 件",
      );
      expect(result.stderr).not.toContain("置換を伴う差分があります");
    });

    it("dev は cdk で、実 AWS の変更セットだけで比べる", () => {
      const result = cdkSh(["dev", "diff"]);

      expect(result.code).toBe(0);
      expect(result.calls).toEqual([
        [
          "--no-install",
          "cdk",
          "diff",
          "-c",
          "stage=dev",
          "--method=change-set",
          "--no-color",
        ],
      ]);
    });

    it("diff 以外のコマンドは、これまでどおり引数をそのまま cdk に渡す", () => {
      const result = cdkSh(["dev", "deploy", "--require-approval", "never"]);

      expect(result.code).toBe(0);
      expect(result.calls).toEqual([
        [
          "--no-install",
          "cdk",
          "deploy",
          "-c",
          "stage=dev",
          "--require-approval",
          "never",
        ],
      ]);
    });
  });

  describe("準正常系", () => {
    it("local で変更セットだけ差分が無いときは、見落としの可能性を警告する（置換が無ければ 0）", () => {
      const result = cdkSh(["local", "diff"], {
        "change-set": { output: NO_DIFFERENCE_OUTPUT },
        template: { output: UPDATE_OUTPUT },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        "差分のあるスタック: 変更セット 0 件・テンプレート 1 件",
      );
      expect(result.stderr).toContain(
        "LocalStack の変更セットが見落とした可能性があります",
      );
    });

    it("変更セットの差分に置換があれば、作り直しを案内して 3 で終わる", () => {
      const result = cdkSh(["local", "diff"], {
        "change-set": { output: REPLACEMENT_OUTPUT },
        template: { output: REPLACEMENT_OUTPUT },
      });

      expect(result.code).toBe(3);
      expect(result.stderr).toContain(
        "scripts/stack.sh local down → up で作り直してください",
      );
    });

    it("置換の印がテンプレートの比較にだけ（リソースの行の末尾にだけ）あっても、3 で終わる", () => {
      const result = cdkSh(["local", "diff"], {
        "change-set": { output: NO_DIFFERENCE_OUTPUT },
        template: { output: REPLACE_SUFFIX_ONLY_OUTPUT },
      });

      expect(result.code).toBe(3);
    });

    it("dev でも、置換があれば 3 で終わる", () => {
      const result = cdkSh(["dev", "diff"], {
        "change-set": { output: REPLACEMENT_OUTPUT },
      });

      expect(result.code).toBe(3);
      expect(result.stderr).toContain("scripts/stack.sh dev down → up");
    });

    it("後ろに付けた引数は、どちらの方法の呼び出しにも渡す", () => {
      const result = cdkSh(["local", "diff", "serverless-practice-app-local"]);

      expect(result.code).toBe(0);
      expect(result.calls.map((call) => call.at(-1))).toEqual([
        "serverless-practice-app-local",
        "serverless-practice-app-local",
      ]);
    });

    it("未知のコマンドは、cdk を呼ばずに 2 で終わる", () => {
      const result = cdkSh(["local", "synth"]);

      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("変更セットの diff が失敗したら、テンプレートの比較に進まずに 1 で終わる（差分なしとみなさない）", () => {
      const result = cdkSh(["local", "diff"], {
        "change-set": { output: "Failed to create change set\n", code: 1 },
      });

      expect(result.code).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.stderr).toContain(
        "cdk diff（--method=change-set）が失敗しました",
      );
    });

    it("テンプレートの比較だけが失敗しても、1 で終わる", () => {
      const result = cdkSh(["local", "diff"], {
        template: { output: "Unable to read template\n", code: 1 },
      });

      expect(result.code).toBe(1);
      expect(result.calls).toHaveLength(2);
    });

    it("差分のあるスタックの数を出力から読めなければ、終了コード 0 でも 1 で終わる（読めないことを差分なしにしない）", () => {
      const result = cdkSh(["dev", "diff"], {
        "change-set": { output: "Stack serverless-practice-app-dev\n" },
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "差分のあるスタックの数を読み取れませんでした",
      );
    });
  });
});
