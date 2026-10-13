import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  SFNClient,
  SendTaskFailureCommand,
  SendTaskHeartbeatCommand,
  SendTaskSuccessCommand,
} from "@aws-sdk/client-sfn";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { InjectedFailureError } from "../../src/errors/injected-failure-error";
import { ValidationError } from "../../src/errors/validation-error";
import { dataSync, handler } from "../../src/handlers/data-sync";
import type { DataSyncDeps } from "../../src/handlers/data-sync";
import { BigQueryStub } from "../../src/stubs/bigquery-stub";
import { CuenoteFcStub } from "../../src/stubs/cuenote-fc-stub";
import { MySqlStub } from "../../src/stubs/mysql-stub";
import type { ExportWriter } from "../../src/types/export";
import { captureLogger } from "../helpers/log-capture";

const BUCKET = "serverless-practice-app-local-exports-000000000000";
const NOW = new Date("2026-10-08T03:04:05.678Z");
const TOKEN = "task-token-1";

// モックするのは外部 I/O である S3 と Step Functions だけ。配信対象・書き出し先・ロガーは本物を使う
const s3Mock = mockClient(S3Client);
const sfnMock = mockClient(SFNClient);

/**
 * 依存を組み立てる。書き出し先は既定で本物のスタブ。待ちは実際には待たず、待った時間を記録する。
 *
 * @param overrides - 差し替える依存（書き出し先の失敗・時刻の境界を試すときだけ）
 * @returns 依存と、出力されたログ・待った時間を読む関数
 */
function setup(overrides: Partial<DataSyncDeps> = {}) {
  const { logger, records } = captureLogger({ function: "data-sync" });
  const sleeps: number[] = [];
  const deps: DataSyncDeps = {
    s3: new S3Client({}),
    sfn: new SFNClient({}),
    bucketName: BUCKET,
    recipients: new MySqlStub(),
    warehouse: new BigQueryStub(logger),
    marketingList: new CuenoteFcStub(logger),
    logger,
    now: () => NOW,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  };
  return {
    deps,
    records,
    sleeps,
    stubs: () =>
      records().flatMap((r) => (typeof r.stub === "string" ? [r.stub] : [])),
  };
}

/**
 * S3 へ送られた PutObject の入力を返す。
 *
 * @returns 送られた順の入力
 */
function puts() {
  return s3Mock
    .commandCalls(PutObjectCommand)
    .map((call) => call.args[0].input);
}

/**
 * Step Functions へ返した結果を、送った順にコマンド名と入力で返す。
 * 成功・失敗・ハートビートの順序まで確かめるため、種類をまたいで並べる。
 *
 * @returns 送った順の `[コマンド名, 入力]`
 */
function callbacks() {
  return sfnMock
    .calls()
    .map((call) => [call.args[0].constructor.name, call.args[0].input]);
}

/**
 * `SendTaskFailure` の `cause` を JSON として読む。
 *
 * @returns 最初に返した失敗の `cause`
 */
function failureCause() {
  const cause = sfnMock.commandCalls(SendTaskFailureCommand)[0]?.args[0].input
    .cause;
  return JSON.parse(cause ?? "null") as unknown;
}

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
  sfnMock.reset();
  sfnMock.on(SendTaskSuccessCommand).resolves({});
  sfnMock.on(SendTaskFailureCommand).resolves({});
  sfnMock.on(SendTaskHeartbeatCommand).resolves({});
});

describe("dataSync", () => {
  describe("正常系", () => {
    it("S3 に連携ファイルを書き、BigQuery → Cuenote FC の順に書き出して、件数とキーを SendTaskSuccess で返す", async () => {
      const { deps, stubs } = setup();

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);

      expect(puts()).toEqual([
        expect.objectContaining({
          Bucket: BUCKET,
          Key: "exports/2026-10-08/run-1.json",
          ContentType: "application/json",
        }),
      ]);
      expect(stubs()).toEqual(["bigquery", "cuenote-fc"]);
      expect(callbacks()).toEqual([
        [
          "SendTaskSuccessCommand",
          {
            taskToken: TOKEN,
            output: JSON.stringify({
              exported: 3,
              s3Key: "exports/2026-10-08/run-1.json",
            }),
          },
        ],
      ]);
    });

    it("連携ファイルの中身は実行名・書き出し時刻（UTC の ISO 8601）・配信対象の全件", async () => {
      const { deps } = setup();

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);

      // SDK の型では Body は文字列・Buffer・ストリームの union。JSON 文字列で送っていることも併せて確かめる
      const body = puts()[0]?.Body;
      expect(typeof body).toBe("string");
      expect(JSON.parse(body as string)).toEqual({
        executionName: "run-1",
        exportedAt: "2026-10-08T03:04:05.678Z",
        recipients: [
          {
            recipientId: "r-001",
            email: "user1@example.com",
            name: "利用者 1",
          },
          {
            recipientId: "r-002",
            email: "user2@example.com",
            name: "利用者 2",
          },
          {
            recipientId: "r-003",
            email: "user3@example.com",
            name: "利用者 3",
          },
        ],
      });
    });

    it("完了したら実行名・件数・キーを info ログに出す", async () => {
      const { deps, records } = setup();

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);

      expect(records().at(-1)).toEqual({
        level: "INFO",
        message: "データ連携を完了しました",
        function: "data-sync",
        executionName: "run-1",
        exported: 3,
        s3Key: "exports/2026-10-08/run-1.json",
      });
    });

    it("holdSeconds があれば、書き出しの後に 60 秒ごとにハートビートを送りながら待ってから成功を返す", async () => {
      const { deps, sleeps, stubs } = setup();

      await dataSync(
        { executionName: "run-1", holdSeconds: 130, taskToken: TOKEN },
        deps,
      );

      // 書き出しは待つ前に終わっている
      expect(stubs()).toEqual(["bigquery", "cuenote-fc"]);
      expect(sleeps).toEqual([60_000, 60_000, 10_000]);
      expect(callbacks().map(([name]) => name)).toEqual([
        "SendTaskHeartbeatCommand",
        "SendTaskHeartbeatCommand",
        "SendTaskHeartbeatCommand",
        "SendTaskSuccessCommand",
      ]);
    });
  });

  describe("準正常系", () => {
    it("failAt=dataSync のとき、S3 には書いた後で失敗を返し、BigQuery・Cuenote FC へは書かない", async () => {
      const { deps, stubs } = setup();

      await dataSync(
        { executionName: "run-1", failAt: "dataSync", taskToken: TOKEN },
        deps,
      );
      expect(puts()).toHaveLength(1);
      expect(stubs()).toEqual([]);
      expect(callbacks()).toEqual([
        [
          "SendTaskFailureCommand",
          expect.objectContaining({
            taskToken: TOKEN,
            error: "InjectedFailureError",
          }),
        ],
      ]);
    });

    it("失敗を返したら例外を投げない（非同期の呼び出しで投げると Lambda が再試行し、処理が二重に走るため）", async () => {
      const { deps } = setup();

      await expect(
        dataSync(
          { executionName: "run-1", failAt: "dataSync", taskToken: TOKEN },
          deps,
        ),
      ).resolves.toBeUndefined();
      expect(callbacks().map(([name]) => name)).toEqual([
        "SendTaskFailureCommand",
      ]);
    });

    it("失敗の cause は Lambda が投げたときと同じ形（errorType / errorMessage）の JSON にする", async () => {
      const { deps } = setup();

      await dataSync(
        { executionName: "run-1", failAt: "dataSync", taskToken: TOKEN },
        deps,
      );

      expect(failureCause()).toEqual({
        errorType: "InjectedFailureError",
        errorMessage: new InjectedFailureError("dataSync").message,
      });
    });

    it.each(["enqueue", "consumer"] as const)(
      "failAt=%s はデータ連携に影響しない",
      async (failAt) => {
        const { deps } = setup();

        await dataSync(
          { executionName: "run-1", failAt, taskToken: TOKEN },
          deps,
        );

        expect(callbacks().map(([name]) => name)).toEqual([
          "SendTaskSuccessCommand",
        ]);
      },
    );

    it("holdSeconds が 0 なら待たず、ハートビートも送らない", async () => {
      const { deps, sleeps } = setup();

      await dataSync(
        { executionName: "run-1", holdSeconds: 0, taskToken: TOKEN },
        deps,
      );

      expect(sleeps).toEqual([]);
      expect(callbacks().map(([name]) => name)).toEqual([
        "SendTaskSuccessCommand",
      ]);
    });

    it("holdSeconds が上限の 1,200 秒なら受け付けて待つ", async () => {
      const { deps, sleeps } = setup();

      await dataSync(
        { executionName: "run-1", holdSeconds: 1200, taskToken: TOKEN },
        deps,
      );

      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(1_200_000);
    });

    it.each([1201, -1, 1.5, "60"])(
      "holdSeconds=%s は ValidationError を返し、何も書かずに待たない",
      async (holdSeconds) => {
        const { deps, sleeps } = setup();

        await dataSync(
          { executionName: "run-1", holdSeconds, taskToken: TOKEN },
          deps,
        );
        expect(puts()).toHaveLength(0);
        expect(sleeps).toEqual([]);
        expect(callbacks()).toEqual([
          [
            "SendTaskFailureCommand",
            expect.objectContaining({ error: "ValidationError" }),
          ],
        ]);
      },
    );

    it("キーの日付は UTC で決める（JST では翌日の 2026-10-07T23:59:59Z でも 10-07）", async () => {
      const { deps } = setup({
        now: () => new Date("2026-10-07T23:59:59.999Z"),
      });

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);

      expect(puts()[0]?.Key).toBe("exports/2026-10-07/run-1.json");
    });

    it("同じ実行名で再実行すると同じキーに書く（上書き）", async () => {
      const { deps } = setup();

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);
      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);

      expect(puts().map((put) => put.Key)).toEqual([
        "exports/2026-10-08/run-1.json",
        "exports/2026-10-08/run-1.json",
      ]);
    });

    it("タスク入力が不正でもタスクトークンが読めれば、S3 に書かずに ValidationError を返し、エラーログを出す", async () => {
      const { deps, records } = setup();

      await dataSync({ executionName: "../x", taskToken: TOKEN }, deps);
      expect(puts()).toHaveLength(0);
      expect(callbacks()).toEqual([
        [
          "SendTaskFailureCommand",
          expect.objectContaining({
            taskToken: TOKEN,
            error: "ValidationError",
          }),
        ],
      ]);
      expect(records()).toEqual([
        expect.objectContaining({
          level: "ERROR",
          errorName: "ValidationError",
        }),
      ]);
    });

    it.each([
      ["無い", { executionName: "run-1" }],
      ["空", { executionName: "run-1", taskToken: "" }],
      ["2,049 文字", { executionName: "run-1", taskToken: "t".repeat(2049) }],
    ])(
      "タスクトークンが%sなら、結果を返せないことをエラーログに出して終え、S3 にも Step Functions にも送らない",
      async (_label, input) => {
        const { deps, records } = setup();

        await dataSync(input, deps);
        expect(puts()).toHaveLength(0);
        expect(callbacks()).toEqual([]);
        expect(records()).toEqual([
          expect.objectContaining({
            level: "ERROR",
            message:
              "タスクトークンが読めないため、結果を Step Functions へ返せません",
          }),
        ]);
      },
    );

    it("失敗したら、実行名付きのエラーログを 1 行出してから失敗を返す", async () => {
      const { deps, records } = setup();

      await dataSync(
        { executionName: "run-1", failAt: "dataSync", taskToken: TOKEN },
        deps,
      );

      expect(records()).toEqual([
        expect.objectContaining({
          level: "ERROR",
          message: "データ連携に失敗しました",
          executionName: "run-1",
          errorName: "InjectedFailureError",
        }),
      ]);
    });
  });

  describe("異常系", () => {
    it("S3 への書き込みが失敗すると失敗を返し、BigQuery・Cuenote FC へは書かない", async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error("AccessDenied"));
      const { deps, stubs } = setup();

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);
      expect(stubs()).toEqual([]);
      expect(failureCause()).toEqual({
        errorType: "Error",
        errorMessage: "AccessDenied",
      });
    });

    it("BigQuery への書き出しが失敗すると、Cuenote FC へは書かずに失敗を返す（S3 の書き込みは残る）", async () => {
      const failingWarehouse: ExportWriter = {
        write: () => Promise.reject(new Error("BigQuery 500")),
      };
      const { deps, stubs } = setup({ warehouse: failingWarehouse });

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);
      expect(puts()).toHaveLength(1);
      expect(stubs()).toEqual([]);
      expect(callbacks().map(([name]) => name)).toEqual([
        "SendTaskFailureCommand",
      ]);
    });

    it("SendTaskSuccess が失敗したら、その失敗を SendTaskFailure で返そうとする", async () => {
      sfnMock.on(SendTaskSuccessCommand).rejects(new Error("Throttling"));
      const { deps } = setup();

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);
      expect(callbacks().map(([name]) => name)).toEqual([
        "SendTaskSuccessCommand",
        "SendTaskFailureCommand",
      ]);
    });

    it("ハートビートが失敗したら待つのをやめ、失敗を返す", async () => {
      sfnMock.on(SendTaskHeartbeatCommand).rejects(new Error("TaskTimedOut"));
      const { deps, sleeps } = setup();

      await dataSync(
        { executionName: "run-1", holdSeconds: 120, taskToken: TOKEN },
        deps,
      );
      expect(sleeps).toEqual([]);
      expect(callbacks().map(([name]) => name)).toEqual([
        "SendTaskHeartbeatCommand",
        "SendTaskFailureCommand",
      ]);
    });

    it("SendTaskFailure も失敗したら、それをエラーログに出して終える", async () => {
      sfnMock.on(SendTaskFailureCommand).rejects(new Error("TaskTimedOut"));
      const { deps, records } = setup();

      await dataSync(
        { executionName: "run-1", failAt: "dataSync", taskToken: TOKEN },
        deps,
      );
      expect(records()).toEqual([
        expect.objectContaining({ message: "データ連携に失敗しました" }),
        expect.objectContaining({
          level: "ERROR",
          message: "失敗を Step Functions へ返せませんでした",
          errorMessage: "TaskTimedOut",
        }),
      ]);
    });

    it("cause のエラーメッセージは 4,096 文字で切り詰める", async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error("x".repeat(5000)));
      const { deps } = setup();

      await dataSync({ executionName: "run-1", taskToken: TOKEN }, deps);
      expect(failureCause()).toEqual({
        errorType: "Error",
        errorMessage: "x".repeat(4096),
      });
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

  it("環境変数のバケットへ書き、成功を返し、function / stage 付きのログを出す", async () => {
    vi.stubEnv("STAGE", "local");
    vi.stubEnv("BUCKET_NAME", BUCKET);

    await handler({ executionName: "run-1", taskToken: TOKEN });

    expect(puts()[0]?.Bucket).toBe(BUCKET);
    expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"function":"data-sync","stage":"local"'),
    );
  });

  it.each([undefined, "Upper-Case", "a/b", "ab", "-leading-hyphen"])(
    "BUCKET_NAME=%s は拒否し、S3 も Step Functions も呼ばない",
    async (bucket) => {
      vi.stubEnv("STAGE", "local");
      vi.stubEnv("BUCKET_NAME", bucket);

      await expect(
        handler({ executionName: "run-1", taskToken: TOKEN }),
      ).rejects.toThrow(ValidationError);
      expect(puts()).toHaveLength(0);
      expect(sfnMock.calls()).toHaveLength(0);
    },
  );
});
