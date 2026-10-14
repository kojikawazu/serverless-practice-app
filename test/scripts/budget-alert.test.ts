import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeAwsState } from "./helpers/fake-aws";

// scripts/budget-alert.sh（予算アラートを作り、設定をそろえる）を、偽の AWS CLI で確かめる（docs/08 #43〜#46）。
// LocalStack は Budgets に対応していないため、外部 I/O の AWS CLI だけを PATH の先頭の偽物に差し替える（testing.md）。
//
// 実 AWS に触れないための備え:
// - スクリプトは一時ディレクトリに複製して動かす。手元の .env（本物の通知先）を読ませない
// - 偽物が呼ばれなかった場合に備え、接続先を到達できないアドレスに、認証情報をダミーにし、プロファイルを外す
// - 各ケースで、偽物が呼ばれたこと（呼び出しの記録）を確かめる

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FAKE_AWS = path.join(import.meta.dirname, "helpers/fake-aws.ts");

const ACCOUNT_ID = "123456789012";
const BUDGET_NAME = "serverless-practice-app-daily-cost";
const EMAIL = "alert-owner@example.com";

/** スクリプトが作る通知（docs/09「予算アラート」） */
const NOTIFICATION = {
  NotificationType: "ACTUAL",
  ComparisonOperator: "GREATER_THAN",
  Threshold: 100,
  ThresholdType: "PERCENTAGE",
};

/** 状態を変える操作。--check・中止・判定不能のときに 1 つも呼ばれてはならない */
const MUTATING = [
  "create-budget",
  "update-budget",
  "create-notification",
  "delete-notification",
  "create-subscriber",
  "delete-subscriber",
];

/** そろった状態。ここから一部を崩してずれを作る */
function alignedState(): FakeAwsState {
  return {
    accountId: ACCOUNT_ID,
    budget: {
      BudgetName: BUDGET_NAME,
      BudgetType: "COST",
      TimeUnit: "DAILY",
      BudgetLimit: { Amount: "3", Unit: "USD" },
    },
    notifications: [
      {
        notification: NOTIFICATION,
        subscribers: [{ SubscriptionType: "EMAIL", Address: EMAIL }],
      },
    ],
  };
}

/** 予算が無い状態 */
function emptyState(): FakeAwsState {
  return { accountId: ACCOUNT_ID, budget: null, notifications: [] };
}

/** スクリプトの実行結果 */
type RunResult = {
  /** 終了コード */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 偽の AWS CLI が受け取った引数（呼ばれた順） */
  calls: string[][];
  /** 実行後の偽の AWS の状態 */
  state: FakeAwsState;
};

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "budget-alert-"));
  mkdirSync(path.join(workDir, "scripts"));
  copyFileSync(
    path.join(REPO_ROOT, "scripts/budget-alert.sh"),
    path.join(workDir, "scripts/budget-alert.sh"),
  );
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
 * 一時ディレクトリに複製したスクリプトを、偽の AWS CLI で実行する。
 *
 * @param initial - 偽の AWS の初期状態
 * @param args - スクリプトの引数
 * @param opts - 実行の条件
 * @param opts.email - 環境変数 BUDGET_ALERT_EMAIL。`null` なら渡さない（既定は {@link EMAIL}）
 * @param opts.answer - 確認のプロンプトへの入力（既定は "y"）
 * @param opts.envFile - 一時ディレクトリに置く .env の中身。省略時は置かない
 * @returns 終了コード・出力・呼び出しの記録・実行後の状態
 */
function run(
  initial: FakeAwsState,
  args: string[] = ["dev"],
  opts: { email?: string | null; answer?: string; envFile?: string } = {},
): RunResult {
  const statePath = path.join(workDir, "state.json");
  const logPath = path.join(workDir, "calls.log");
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(logPath, "");
  if (opts.envFile !== undefined) {
    writeFileSync(path.join(workDir, ".env"), opts.envFile);
  }
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
  const email = opts.email === undefined ? EMAIL : opts.email;
  if (email !== null) {
    env["BUDGET_ALERT_EMAIL"] = email;
  }
  const result = spawnSync(
    "bash",
    [path.join(workDir, "scripts/budget-alert.sh"), ...args],
    {
      env,
      input: `${opts.answer ?? "y"}\n`,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    // 記録・状態は偽の AWS CLI（fake-aws.ts）が書いたもので、形はこちらで決めている。検証せずに型を当てる
    calls: readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]),
    state: JSON.parse(readFileSync(statePath, "utf8")) as FakeAwsState,
  };
}

/**
 * 呼ばれた Budgets の操作名を、呼ばれた順に返す。
 *
 * @param result - 実行結果
 * @returns 操作名の配列
 */
function budgetOperations(result: RunResult): string[] {
  return result.calls
    .map((call) => {
      // オプション（--name value の組）を除いた残りが「サービス名 操作名」
      const positional = call.filter(
        (arg, i) =>
          !arg.startsWith("--") && !(call[i - 1] ?? "").startsWith("--"),
      );
      return positional;
    })
    .filter(([service]) => service === "budgets")
    .map(([, operation]) => operation ?? "");
}

/**
 * 状態を変える操作だけを返す。
 *
 * @param result - 実行結果
 * @returns 状態を変える操作名の配列
 */
function mutations(result: RunResult): string[] {
  return budgetOperations(result).filter((op) => MUTATING.includes(op));
}

describe("budget-alert.sh", () => {
  describe("正常系", () => {
    it("予算が無ければ、日次 3 USD の予算と、実績 100% 超でメールする通知を作り、0 で終わる", () => {
      const result = run(emptyState());

      expect(result.code).toBe(0);
      expect(mutations(result)).toEqual(["create-budget"]);
      expect(result.state).toEqual({ ...alignedState() });
      expect(result.stdout).toContain("すべての設定がそろいました");
      // 偽物が呼ばれたこと（本物の AWS CLI に届いていないこと）
      expect(result.calls[0]).toEqual(
        expect.arrayContaining(["sts", "get-caller-identity"]),
      );
    });

    it("そろっていれば何も変えず、0 で終わる（2 回目の実行）", () => {
      const first = run(emptyState());
      const second = run(first.state);

      expect(second.code).toBe(0);
      expect(mutations(second)).toEqual([]);
      expect(second.state).toEqual(first.state);
      expect(second.stdout).toContain("すべての設定がそろっています");
    });

    it("--check はそろっていれば 0 で終わる", () => {
      const result = run(alignedState(), ["dev", "--check"]);

      expect(result.code).toBe(0);
      expect(mutations(result)).toEqual([]);
    });

    it("環境変数が無ければ .env の BUDGET_ALERT_EMAIL を通知先にする（.env を source しない）", () => {
      const result = run(emptyState(), ["dev"], {
        email: null,
        envFile:
          // source されると $(...) が実行されて印のファイルができる。読むのは BUDGET_ALERT_EMAIL の 1 行だけのはず
          'LOCALSTACK_AUTH_TOKEN=$(touch "$HOME/env-was-executed")\nBUDGET_ALERT_EMAIL="from-env-file@example.com"\n',
      });

      expect(result.code).toBe(0);
      expect(result.state.notifications[0]?.subscribers).toEqual([
        { SubscriptionType: "EMAIL", Address: "from-env-file@example.com" },
      ]);
      expect(existsSync(path.join(workDir, "env-was-executed"))).toBe(false);
    });
  });

  describe("準正常系", () => {
    it("額がずれていれば、予算の額だけを直す", () => {
      const initial = alignedState();
      if (initial.budget !== null) {
        initial.budget.BudgetLimit.Amount = "50";
      }

      const result = run(initial);

      expect(result.code).toBe(0);
      expect(mutations(result)).toEqual(["update-budget"]);
      expect(result.state).toEqual(alignedState());
    });

    it("通知先が違えば、正しい通知先を足して余分な通知先を消す", () => {
      const initial = alignedState();
      initial.notifications[0] = {
        notification: NOTIFICATION,
        subscribers: [
          { SubscriptionType: "EMAIL", Address: "old@example.com" },
        ],
      };

      const result = run(initial);

      expect(result.code).toBe(0);
      expect(mutations(result)).toEqual([
        "create-subscriber",
        "delete-subscriber",
      ]);
      expect(result.state).toEqual(alignedState());
    });

    it("余分な通知（予測 80%）は消し、正しい通知は残す", () => {
      const initial = alignedState();
      initial.notifications.push({
        notification: {
          ...NOTIFICATION,
          NotificationType: "FORECASTED",
          Threshold: 80,
        },
        subscribers: [{ SubscriptionType: "EMAIL", Address: EMAIL }],
      });

      const result = run(initial);

      expect(result.code).toBe(0);
      expect(mutations(result)).toEqual(["delete-notification"]);
      expect(result.state).toEqual(alignedState());
    });

    it("予算はあるが通知が無ければ、通知と通知先を足す（予算は作り直さない）", () => {
      const initial = alignedState();
      initial.notifications = [];

      const result = run(initial);

      expect(result.code).toBe(0);
      expect(mutations(result)).toEqual(["create-notification"]);
      expect(result.state).toEqual(alignedState());
    });

    it("通知の一覧が NotFoundException でも、予算があれば「通知 0 件」として通知を足す", () => {
      const initial = alignedState();
      initial.notifications = [];
      initial.failOn = {
        "describe-notifications-for-budget": "NotFoundException",
      };

      const result = run(initial);

      expect(mutations(result)).toEqual(["create-notification"]);
      // 読み直しでも NotFoundException が返り続けるため、反映を確かめられずに 1 で終わる（判定不能を成功にしない）
      expect(result.code).toBe(1);
    });

    it("--check はずれがあれば何も変えずに 1 で終わり、直す内容を出す", () => {
      const result = run(emptyState(), ["dev", "--check"]);

      expect(result.code).toBe(1);
      expect(mutations(result)).toEqual([]);
      expect(result.stdout).toContain("予算を作る");
      expect(result.stderr).toContain("ずれがある項目: 1 件");
    });

    it("確認で y 以外を答えると、何も変えずに 1 で終わる", () => {
      const result = run(emptyState(), ["dev"], { answer: "n" });

      expect(result.code).toBe(1);
      expect(mutations(result)).toEqual([]);
      expect(result.stderr).toContain("中止しました");
    });

    it("同じ名前で期間の違う予算（月次）は、別の用途として直さずに 1 で終わる", () => {
      const initial = alignedState();
      if (initial.budget !== null) {
        initial.budget.TimeUnit = "MONTHLY";
      }

      const result = run(initial);

      expect(result.code).toBe(1);
      expect(mutations(result)).toEqual([]);
      expect(result.stderr).toContain("TimeUnit が MONTHLY");
    });

    it("画面にはメールアドレスを伏せて出す", () => {
      const result = run(emptyState(), ["dev", "--check"]);

      expect(result.stdout).toContain("a***@example.com");
      expect(result.stdout + result.stderr).not.toContain(EMAIL);
    });

    it.each([
      [[]],
      [["local"]],
      [["dev", "--force"]],
      [["dev", "--check", "extra"]],
    ])("引数 %j は使い方の誤りとして、AWS を呼ばずに 2 で終わる", (args) => {
      const result = run(emptyState(), args);

      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
    });

    it.each([
      ["無い", null],
      ["空", ""],
      ["形式が違う", "not-an-email"],
    ])("通知先が%sなら、AWS を呼ばずに 2 で終わる", (_label, email) => {
      const result = run(emptyState(), ["dev"], { email });

      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("予算を読めない（権限不足）ときは、「無い」とみなして作らずに 1 で終わる", () => {
      const initial = emptyState();
      initial.failOn = { "describe-budget": "AccessDeniedException" };

      const result = run(initial);

      expect(result.code).toBe(1);
      expect(mutations(result)).toEqual([]);
      expect(result.stderr).toContain("AccessDeniedException");
    });

    it("通知を読めない（権限不足）ときは、何も変えずに 1 で終わる", () => {
      const initial = alignedState();
      initial.failOn = {
        "describe-notifications-for-budget": "AccessDeniedException",
      };

      const result = run(initial);

      expect(result.code).toBe(1);
      expect(mutations(result)).toEqual([]);
    });

    it("作成が失敗したら 1 で終わる", () => {
      const initial = emptyState();
      initial.failOn = { "create-budget": "ThrottlingException" };

      const result = run(initial);

      expect(result.code).toBe(1);
      expect(result.state.budget).toBeNull();
    });

    it("API が成功を返しても反映されていなければ、読み直して 1 で終わる", () => {
      const initial = alignedState();
      if (initial.budget !== null) {
        initial.budget.BudgetLimit.Amount = "50";
      }
      initial.ignore = ["update-budget"];

      const result = run(initial);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("読み直すとそろっていません");
    });
  });
});
