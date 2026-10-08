import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { ValidationError } from "../../src/errors/validation-error";
import { handler, notifySlack } from "../../src/handlers/notify-slack";
import { SlackStub } from "../../src/stubs/slack-stub";
import { captureLogger } from "../helpers/log-capture";

const EXECUTION_ARN =
  "arn:aws:states:ap-northeast-1:000000000000:execution:batch:run-1";

/**
 * EventBridge が届ける状態変化イベントを作る。
 *
 * @param detail - detail の上書き
 * @returns イベント
 */
function event(detail: Record<string, unknown> = {}) {
  return {
    version: "0",
    source: "aws.states",
    "detail-type": "Step Functions Execution Status Change",
    detail: {
      executionArn: EXECUTION_ARN,
      stateMachineArn:
        "arn:aws:states:ap-northeast-1:000000000000:stateMachine:batch",
      name: "run-1",
      status: "FAILED",
      startDate: 1_791_417_600_000,
      stopDate: 1_791_417_605_000,
      error: "InjectedFailureError",
      cause: "failAt=dataSync の指定により失敗を注入しました",
      ...detail,
    },
  };
}

/**
 * 通知 Lambda の依存を組み立てる。通知先は本物の Slack スタブで、ログを捕捉して通知を確かめる。
 *
 * @returns 依存と、Slack スタブの出力・全ログを読む関数
 */
function setup() {
  const { logger, records } = captureLogger({ function: "notify-slack" });
  return {
    deps: { notifier: new SlackStub(logger), logger },
    slack: () => records().filter((r) => r.stub === "slack"),
    records,
  };
}

describe("notifySlack", () => {
  describe("正常系", () => {
    it("FAILED のイベントで、実行名・状態・エラー名・原因・実行 ARN を Slack スタブへ出す", async () => {
      const { deps, slack } = setup();

      await notifySlack(event(), deps);

      expect(slack()).toEqual([
        {
          level: "INFO",
          message: "実行の失敗を通知しました（スタブ）",
          function: "notify-slack",
          stub: "slack",
          executionName: "run-1",
          executionArn: EXECUTION_ARN,
          status: "FAILED",
          error: "InjectedFailureError",
          cause: "failAt=dataSync の指定により失敗を注入しました",
        },
      ]);
    });
  });

  describe("準正常系", () => {
    it.each(["TIMED_OUT", "ABORTED"])(
      "%s で error / cause が null でも通知する",
      async (status) => {
        const { deps, slack } = setup();

        await notifySlack(event({ status, error: null, cause: null }), deps);

        expect(slack()).toEqual([
          expect.objectContaining({ status, error: null, cause: null }),
        ]);
      },
    );

    it("error / cause の項目自体が無ければ null として通知する", async () => {
      const { deps, slack } = setup();
      const { error: _error, cause: _cause, ...detail } = event().detail;

      await notifySlack({ ...event(), detail }, deps);

      expect(slack()).toEqual([
        expect.objectContaining({ error: null, cause: null }),
      ]);
    });

    it("対象外の detail-type では通知せず、エラーも投げずに警告ログを出す", async () => {
      const { deps, slack, records } = setup();

      await expect(
        notifySlack(
          {
            ...event(),
            "detail-type": "Step Functions State Machine Status Change",
          },
          deps,
        ),
      ).resolves.toBeUndefined();

      expect(slack()).toEqual([]);
      expect(records()).toEqual([
        expect.objectContaining({
          level: "WARN",
          message: "通知対象外のイベントのため通知しません",
          reason: expect.stringContaining("detail-type") as unknown,
        }),
      ]);
    });

    it("SUCCEEDED（通知対象外の状態）では通知しない", async () => {
      const { deps, slack, records } = setup();

      await notifySlack(event({ status: "SUCCEEDED" }), deps);

      expect(slack()).toEqual([]);
      expect(records()[0]?.level).toBe("WARN");
    });
  });

  describe("異常系", () => {
    it.each([null, "文字列", 42, {}])(
      "イベントとして読めない値 %j でも例外を投げず、警告ログを出す",
      async (input) => {
        const { deps, records } = setup();

        await expect(notifySlack(input, deps)).resolves.toBeUndefined();
        expect(records()).toEqual([expect.objectContaining({ level: "WARN" })]);
      },
    );

    it("通知先が失敗したら、実行名付きのエラーログを出してから投げ直す（Lambda の再試行に任せる）", async () => {
      const { logger, records } = captureLogger({ function: "notify-slack" });
      const failingNotifier = {
        notify: () => Promise.reject(new Error("Slack 429")),
      };

      await expect(
        notifySlack(event(), { notifier: failingNotifier, logger }),
      ).rejects.toThrow("Slack 429");
      expect(records()).toEqual([
        expect.objectContaining({
          level: "ERROR",
          message: "失敗の通知に失敗しました",
          executionName: "run-1",
          errorMessage: "Slack 429",
        }),
      ]);
    });
  });
});

describe("handler（Lambda の入口）", () => {
  // 標準出力（外部 I/O）だけを差し替え、出力された行を検証する
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("function / stage 付きのロガーで通知する", async () => {
    vi.stubEnv("STAGE", "dev");

    await handler(event());
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining(
        '"function":"notify-slack","stage":"dev","stub":"slack"',
      ),
    );
  });

  it("STAGE が無ければ ValidationError を投げる", async () => {
    vi.stubEnv("STAGE", undefined);

    await expect(handler(event())).rejects.toThrow(ValidationError);
  });
});
