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
import type { FakeSfnState } from "./helpers/fake-aws-sfn";

// scripts/batch.sh の run（実行を起動して結果を待つ）を、偽の AWS CLI で確かめる（docs/08 #47〜#49）。
// 実行の結果（終わらない・失敗する）を思いどおりに作るため、外部 I/O の AWS CLI だけを PATH の先頭の偽物に差し替える（testing.md）。
//
// 実 AWS に触れないための備え（budget-alert.test.ts と同じ）:
// - 偽物が呼ばれなかった場合に備え、接続先を到達できないアドレスに、認証情報をダミーにし、プロファイルを外す
// - 各ケースで、偽物が呼ばれたこと（呼び出しの記録・起動の記録）を確かめる
// ステージは dev を使う。local だと use_stage_aws が接続先を LocalStack に向け直すため。

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BATCH_SH = path.join(REPO_ROOT, "scripts/batch.sh");
const FAKE_AWS = path.join(import.meta.dirname, "helpers/fake-aws-sfn.ts");

const STATE_MACHINE_ARN =
  "arn:aws:states:ap-northeast-1:123456789012:stateMachine:serverless-practice-app-dev-batch";

/**
 * デプロイ済みで、実行がすぐ終わる状態を作る。
 *
 * @param statuses - describe-execution が返す状態の列（既定は 1 回目で `SUCCEEDED`）
 * @returns 偽の Step Functions の初期状態
 */
function deployedState(statuses: string[] = ["SUCCEEDED"]): FakeSfnState {
  return {
    stateMachines: [
      {
        name: "serverless-practice-app-dev-batch",
        stateMachineArn: STATE_MACHINE_ARN,
      },
    ],
    statuses,
    describeCount: 0,
    started: null,
  };
}

/** スクリプトの実行結果 */
type RunResult = {
  /** 終了コード */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 偽の AWS CLI が受け取った引数（呼ばれた順） */
  calls: string[][];
  /** 実行後の偽の Step Functions の状態 */
  state: FakeSfnState;
};

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "batch-"));
  mkdirSync(path.join(workDir, "bin"));
  writeFileSync(
    path.join(workDir, "bin/aws"),
    `#!/bin/sh\nexec node --experimental-strip-types --no-warnings "${FAKE_AWS}" "$@"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * batch.sh を偽の AWS CLI で実行する。
 *
 * @param initial - 偽の Step Functions の初期状態
 * @param args - stage の後に続く引数（`run ...`）
 * @param waitSeconds - 環境変数 BATCH_WAIT_SECONDS。省略時は渡さない（既定の待ち時間を使う）
 * @returns 終了コード・出力・呼び出しの記録・実行後の状態
 */
function batch(
  initial: FakeSfnState,
  args: string[],
  waitSeconds?: string,
): RunResult {
  const statePath = path.join(workDir, "state.json");
  const logPath = path.join(workDir, "calls.log");
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(logPath, "");
  // 手元の AWS の設定（プロファイル・認証情報）を引き継がない
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.join(workDir, "bin")}:${process.env["PATH"] ?? ""}`,
    HOME: workDir,
    FAKE_AWS_STATE: statePath,
    FAKE_AWS_LOG: logPath,
    AWS_ENDPOINT_URL: "http://127.0.0.1:9",
    AWS_ACCESS_KEY_ID: "fake",
    AWS_SECRET_ACCESS_KEY: "fake",
    AWS_REGION: "ap-northeast-1",
  };
  if (waitSeconds !== undefined) {
    env["BATCH_WAIT_SECONDS"] = waitSeconds;
  }
  const result = spawnSync("bash", [BATCH_SH, "dev", ...args], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    // 記録・状態は偽の AWS CLI（fake-aws-sfn.ts）が書いたもので、形はこちらで決めている。検証せずに型を当てる
    calls: readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]),
    state: JSON.parse(readFileSync(statePath, "utf8")) as FakeSfnState,
  };
}

/**
 * 実行の入力を、ステートマシンが受け取る JSON として読む。
 *
 * @param result - 実行結果
 * @returns start-execution に渡った入力
 */
function startedInput(result: RunResult): unknown {
  expect(result.state.started).not.toBeNull();
  return JSON.parse(result.state.started?.input ?? "");
}

describe("batch.sh run", () => {
  describe("正常系", () => {
    it("引数なしなら入力 {} で起動し、結果の状態を出して 0 で終わる。待つのは 360 秒", () => {
      const result = batch(deployedState(), ["run"]);

      expect(result.code).toBe(0);
      expect(startedInput(result)).toEqual({});
      expect(result.state.started?.name).toMatch(/^manual-\d{8}-\d{6}$/);
      expect(result.stdout).toContain("最大 360 秒待ちます");
      expect(result.stdout).toContain("状態: SUCCEEDED");
      expect(result.stdout).toContain("エラー: -");
    });

    it("failAt と --hold-seconds を入力に入れ（holdSeconds は数値）、待つ秒数に holdSeconds を足す", () => {
      const result = batch(deployedState(), [
        "run",
        "dataSync",
        "--hold-seconds",
        "960",
      ]);

      expect(result.code).toBe(0);
      expect(startedInput(result)).toEqual({
        failAt: "dataSync",
        holdSeconds: 960,
      });
      expect(result.stdout).toContain("最大 1320 秒待ちます");
    });

    it("--hold-seconds は failAt の前にも置け、上限の 1200 も待つ秒数に足す", () => {
      const result = batch(deployedState(), [
        "run",
        "--hold-seconds",
        "1200",
        "consumer",
      ]);

      expect(result.code).toBe(0);
      expect(startedInput(result)).toEqual({
        failAt: "consumer",
        holdSeconds: 1200,
      });
      expect(result.stdout).toContain("最大 1560 秒待ちます");
    });

    it("RUNNING の間は待ち、終わったら FAILED でも 0 で終わり、cause はメッセージだけを出す", () => {
      const initial = {
        ...deployedState(["RUNNING", "FAILED"]),
        error: "InjectedFailureError",
        cause: JSON.stringify({
          errorType: "InjectedFailureError",
          errorMessage: "dataSync で失敗を注入しました",
          trace: ["at handler (index.mjs:1:1)"],
        }),
      };

      const result = batch(initial, ["run", "dataSync"]);

      expect(result.code).toBe(0);
      expect(result.state.describeCount).toBe(3);
      expect(result.stdout).toContain("状態: FAILED");
      expect(result.stdout).toContain("エラー: InjectedFailureError");
      expect(result.stdout).toContain("原因: dataSync で失敗を注入しました");
      expect(result.stdout).not.toContain("trace");
    });
  });

  describe("準正常系", () => {
    it.each([
      // 範囲外・小数・負の数は数値のまま渡し、スキーマに拒否させる。待つ秒数は延ばさない
      { value: "1201", expected: 1201 },
      { value: "1.5", expected: 1.5 },
      { value: "-1", expected: -1 },
      // 数値として読めないもの（先頭が 0 の数を含む）は文字列で渡す
      { value: "abc", expected: "abc" },
      { value: "0960", expected: "0960" },
      { value: "", expected: "" },
    ])(
      "--hold-seconds $value は検証させるため $expected として渡し、待つのは 360 秒のまま",
      ({ value, expected }) => {
        const result = batch(deployedState(), ["run", "--hold-seconds", value]);

        expect(result.code).toBe(0);
        expect(startedInput(result)).toEqual({ holdSeconds: expected });
        expect(result.stdout).toContain("最大 360 秒待ちます");
      },
    );

    it("BATCH_WAIT_SECONDS があれば、holdSeconds があってもその秒数だけ待つ", () => {
      const result = batch(
        deployedState(),
        ["run", "--hold-seconds", "960"],
        "30",
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("最大 30 秒待ちます");
    });

    it.each([
      { label: "--hold-seconds に値が無い", args: ["run", "--hold-seconds"] },
      { label: "未知のオプション", args: ["run", "--hold=960"] },
      { label: "failAt が 2 つ", args: ["run", "dataSync", "consumer"] },
    ])("$label なら、起動せずに使い方を出して 2 で終わる", ({ args }) => {
      const result = batch(deployedState(), args);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("使い方:");
      expect(result.state.started).toBeNull();
      expect(result.calls).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("待つ秒数を過ぎても RUNNING なら、終わったとみなさずに 1 で終わる", () => {
      const result = batch(deployedState(["RUNNING"]), ["run"], "1");

      expect(result.code).toBe(1);
      expect(result.state.started).not.toBeNull();
      expect(result.stderr).toContain("1 秒待っても実行 manual-");
      expect(result.stderr).toContain("（状態: RUNNING）");
      expect(result.stdout).not.toContain("状態: ");
    });

    it("ステートマシンの一覧を取れなければ、認証を確かめるよう出し、起動せずに 1 で終わる", () => {
      const result = batch(
        {
          ...deployedState(),
          failOn: { "list-state-machines": "ExpiredTokenException" },
        },
        ["run"],
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "ステートマシンの一覧を取得できません。AWS の認証（aws login）と接続先を確認してください",
      );
      expect(result.stderr).not.toContain("見つかりません");
      expect(result.state.started).toBeNull();
    });

    it("ステートマシンが無ければ、デプロイを促し、起動せずに 1 で終わる", () => {
      const result = batch({ ...deployedState(), stateMachines: [] }, ["run"]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "ステートマシン serverless-practice-app-dev-batch が見つかりません。scripts/stack.sh dev up でデプロイしてください",
      );
      expect(result.calls).toHaveLength(1);
      expect(result.state.started).toBeNull();
    });
  });
});
