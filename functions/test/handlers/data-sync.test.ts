import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

// モックするのは外部 I/O である S3 だけ。配信対象・書き出し先・ロガーは本物を使う
const s3Mock = mockClient(S3Client);

/**
 * 依存を組み立てる。書き出し先は既定で本物のスタブ。
 *
 * @param overrides - 差し替える依存（書き出し先の失敗・時刻の境界を試すときだけ）
 * @returns 依存と、出力されたログを読む関数
 */
function setup(overrides: Partial<DataSyncDeps> = {}) {
  const { logger, records } = captureLogger({ function: "data-sync" });
  const deps: DataSyncDeps = {
    s3: new S3Client({}),
    bucketName: BUCKET,
    recipients: new MySqlStub(),
    warehouse: new BigQueryStub(logger),
    marketingList: new CuenoteFcStub(logger),
    logger,
    now: () => NOW,
    ...overrides,
  };
  return {
    deps,
    records,
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

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

describe("dataSync", () => {
  describe("正常系", () => {
    it("S3 に連携ファイルを書き、BigQuery → Cuenote FC の順に書き出して、件数とキーを返す", async () => {
      const { deps, stubs } = setup();

      const result = await dataSync({ executionName: "run-1" }, deps);

      expect(result).toEqual({
        exported: 3,
        s3Key: "exports/2026-10-08/run-1.json",
      });
      expect(puts()).toEqual([
        expect.objectContaining({
          Bucket: BUCKET,
          Key: "exports/2026-10-08/run-1.json",
          ContentType: "application/json",
        }),
      ]);
      expect(stubs()).toEqual(["bigquery", "cuenote-fc"]);
    });

    it("連携ファイルの中身は実行名・書き出し時刻（UTC の ISO 8601）・配信対象の全件", async () => {
      const { deps } = setup();

      await dataSync({ executionName: "run-1" }, deps);

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

      await dataSync({ executionName: "run-1" }, deps);

      expect(records().at(-1)).toEqual({
        level: "INFO",
        message: "データ連携を完了しました",
        function: "data-sync",
        executionName: "run-1",
        exported: 3,
        s3Key: "exports/2026-10-08/run-1.json",
      });
    });
  });

  describe("準正常系", () => {
    it("failAt=dataSync のとき、S3 には書いた後で失敗し、BigQuery・Cuenote FC へは書かない", async () => {
      const { deps, stubs } = setup();

      await expect(
        dataSync({ executionName: "run-1", failAt: "dataSync" }, deps),
      ).rejects.toThrow(InjectedFailureError);
      expect(puts()).toHaveLength(1);
      expect(stubs()).toEqual([]);
    });

    it.each(["enqueue", "consumer"] as const)(
      "failAt=%s はデータ連携に影響しない",
      async (failAt) => {
        const { deps } = setup();

        await expect(
          dataSync({ executionName: "run-1", failAt }, deps),
        ).resolves.toEqual({
          exported: 3,
          s3Key: "exports/2026-10-08/run-1.json",
        });
      },
    );

    it("キーの日付は UTC で決める（JST では翌日の 2026-10-07T23:59:59Z でも 10-07）", async () => {
      const { deps } = setup({
        now: () => new Date("2026-10-07T23:59:59.999Z"),
      });

      await expect(
        dataSync({ executionName: "run-1" }, deps),
      ).resolves.toMatchObject({
        s3Key: "exports/2026-10-07/run-1.json",
      });
    });

    it("同じ実行名で再実行すると同じキーに書く（上書き）", async () => {
      const { deps } = setup();

      await dataSync({ executionName: "run-1" }, deps);
      await dataSync({ executionName: "run-1" }, deps);

      expect(puts().map((put) => put.Key)).toEqual([
        "exports/2026-10-08/run-1.json",
        "exports/2026-10-08/run-1.json",
      ]);
    });

    it("タスク入力が不正なら S3 に書かずに ValidationError を投げ、エラーログを出す", async () => {
      const { deps, records } = setup();

      await expect(dataSync({ executionName: "../x" }, deps)).rejects.toThrow(
        ValidationError,
      );
      expect(puts()).toHaveLength(0);
      expect(records()).toEqual([
        expect.objectContaining({
          level: "ERROR",
          errorName: "ValidationError",
        }),
      ]);
    });

    it("失敗したら、実行名付きのエラーログを 1 行出してから投げ直す", async () => {
      const { deps, records } = setup();

      await expect(
        dataSync({ executionName: "run-1", failAt: "dataSync" }, deps),
      ).rejects.toThrow();

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
    it("S3 への書き込みが失敗すると例外を投げ、BigQuery・Cuenote FC へは書かない", async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error("AccessDenied"));
      const { deps, stubs } = setup();

      await expect(dataSync({ executionName: "run-1" }, deps)).rejects.toThrow(
        "AccessDenied",
      );
      expect(stubs()).toEqual([]);
    });

    it("BigQuery への書き出しが失敗すると、Cuenote FC へは書かずに例外を投げる（S3 の書き込みは残る）", async () => {
      const failingWarehouse: ExportWriter = {
        write: () => Promise.reject(new Error("BigQuery 500")),
      };
      const { deps, stubs } = setup({ warehouse: failingWarehouse });

      await expect(dataSync({ executionName: "run-1" }, deps)).rejects.toThrow(
        "BigQuery 500",
      );
      expect(puts()).toHaveLength(1);
      expect(stubs()).toEqual([]);
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

  it("環境変数のバケットへ書き、function / stage 付きのログを出す", async () => {
    vi.stubEnv("STAGE", "local");
    vi.stubEnv("BUCKET_NAME", BUCKET);

    await expect(handler({ executionName: "run-1" })).resolves.toMatchObject({
      exported: 3,
    });
    expect(puts()[0]?.Bucket).toBe(BUCKET);
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"function":"data-sync","stage":"local"'),
    );
  });

  it.each([undefined, "Upper-Case", "a/b", "ab", "-leading-hyphen"])(
    "BUCKET_NAME=%s は拒否し、S3 を呼ばない",
    async (bucket) => {
      vi.stubEnv("STAGE", "local");
      vi.stubEnv("BUCKET_NAME", bucket);

      await expect(handler({ executionName: "run-1" })).rejects.toThrow(
        ValidationError,
      );
      expect(puts()).toHaveLength(0);
    },
  );
});
