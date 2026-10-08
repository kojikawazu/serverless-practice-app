import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SendMessageBatchRequestEntry } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { EnqueuePartialFailureError } from "../../src/errors/enqueue-partial-failure-error";
import { InjectedFailureError } from "../../src/errors/injected-failure-error";
import { ValidationError } from "../../src/errors/validation-error";
import { enqueue, handler } from "../../src/handlers/enqueue";
import type { EnqueueDeps } from "../../src/handlers/enqueue";
import { mailMessageSchema } from "../../src/schemas/mail-message";
import { MySqlStub } from "../../src/stubs/mysql-stub";
import type { Recipient, RecipientRepository } from "../../src/types/recipient";
import { captureLogger } from "../helpers/log-capture";

const QUEUE_URL =
  "http://sqs.ap-northeast-1.localhost.localstack.cloud:4566/000000000000/mail.fifo";

// モックするのは外部 I/O である SQS だけ。配信対象（MySQL スタブ）とロガーは本物を使う
const sqsMock = mockClient(SQSClient);

/**
 * 依存を組み立てる。配信対象は既定で MySQL スタブ（3 件）。
 *
 * @param recipients - 配信対象の取得元。件数を変えたいケースだけ差し替える
 * @returns 依存と、出力されたログを読む関数
 */
function setup(recipients: RecipientRepository = new MySqlStub()) {
  const { logger, records } = captureLogger({ function: "enqueue" });
  const deps: EnqueueDeps = {
    sqs: new SQSClient({}),
    queueUrl: QUEUE_URL,
    recipients,
    logger,
  };
  return { deps, records };
}

/**
 * 指定件数の配信対象を返す取得元。MySQL スタブの固定 3 件では試せない件数（バッチ分割・0 件）に使う。
 *
 * @param count - 件数
 * @returns 配信対象の取得元
 */
function recipientsOf(count: number): RecipientRepository {
  const recipients: Recipient[] = Array.from({ length: count }, (_, i) => {
    const id = String(i + 1).padStart(3, "0");
    return {
      recipientId: `r-${id}`,
      email: `user${id}@example.com`,
      name: `利用者 ${id}`,
    };
  });
  return { findAll: () => Promise.resolve(recipients) };
}

/**
 * 送られた全バッチのエントリを、送った順に平らにして返す。
 *
 * @returns 送られたエントリ
 */
function sentEntries(): SendMessageBatchRequestEntry[] {
  return sqsMock
    .commandCalls(SendMessageBatchCommand)
    .flatMap((call) => call.args[0].input.Entries ?? []);
}

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
});

describe("enqueue", () => {
  describe("正常系", () => {
    it("配信対象 3 件を 1 回の SendMessageBatch でキューへ送り、件数を返す", async () => {
      const { deps } = setup();

      const result = await enqueue({ executionName: "run-1" }, deps);

      expect(result).toEqual({ enqueued: 3 });
      const calls = sqsMock.commandCalls(SendMessageBatchCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0].input.QueueUrl).toBe(QUEUE_URL);
      expect(calls[0]?.args[0].input.Entries).toHaveLength(3);
    });

    it("重複排除 ID は <実行名>:<配信対象 ID>、グループ ID とバッチ内 ID は配信対象 ID になる", async () => {
      const { deps } = setup();

      await enqueue({ executionName: "run-1" }, deps);

      expect(
        sentEntries().map(({ Id, MessageGroupId, MessageDeduplicationId }) => ({
          Id,
          MessageGroupId,
          MessageDeduplicationId,
        })),
      ).toEqual([
        {
          Id: "r-001",
          MessageGroupId: "r-001",
          MessageDeduplicationId: "run-1:r-001",
        },
        {
          Id: "r-002",
          MessageGroupId: "r-002",
          MessageDeduplicationId: "run-1:r-002",
        },
        {
          Id: "r-003",
          MessageGroupId: "r-003",
          MessageDeduplicationId: "run-1:r-003",
        },
      ]);
    });

    it("本文は Consumer が検証に使うスキーマをそのまま通る（作る側と読む側の契約が一致する）", async () => {
      const { deps } = setup();

      await enqueue({ executionName: "run-1" }, deps);

      const bodies = sentEntries().map((entry) =>
        mailMessageSchema.parse(JSON.parse(entry.MessageBody ?? "")),
      );
      expect(bodies[0]).toEqual({
        executionName: "run-1",
        recipientId: "r-001",
        email: "user1@example.com",
        subject: "serverless-practice-app デモ配信",
        simulateFailure: false,
      });
    });

    it("failAt=consumer のとき、全メッセージの simulateFailure が true になる", async () => {
      const { deps } = setup();

      await enqueue({ executionName: "run-1", failAt: "consumer" }, deps);

      const flags = sentEntries().map(
        (entry) =>
          mailMessageSchema.parse(JSON.parse(entry.MessageBody ?? ""))
            .simulateFailure,
      );
      expect(flags).toEqual([true, true, true]);
    });

    it("成功したら実行名と件数を info ログに出す", async () => {
      const { deps, records } = setup();

      await enqueue({ executionName: "run-1" }, deps);

      expect(records()).toEqual([
        {
          level: "INFO",
          message: "メールメッセージを投入しました",
          function: "enqueue",
          executionName: "run-1",
          enqueued: 3,
        },
      ]);
    });
  });

  describe("準正常系", () => {
    it("failAt=enqueue のとき、SQS を呼ばずに InjectedFailureError を投げる", async () => {
      const { deps } = setup();

      await expect(
        enqueue({ executionName: "run-1", failAt: "enqueue" }, deps),
      ).rejects.toThrow(InjectedFailureError);
      expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    });

    it("failAt=dataSync は投入には影響せず、simulateFailure は false のまま送る", async () => {
      const { deps } = setup();

      await expect(
        enqueue({ executionName: "run-1", failAt: "dataSync" }, deps),
      ).resolves.toEqual({ enqueued: 3 });
      expect(
        sentEntries().every((entry) =>
          entry.MessageBody?.includes('"simulateFailure":false'),
        ),
      ).toBe(true);
    });

    it("未定義の failAt では SQS を呼ばずに ValidationError を投げる", async () => {
      const { deps } = setup();

      await expect(
        enqueue({ executionName: "run-1", failAt: "notify" }, deps),
      ).rejects.toThrow(ValidationError);
      expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    });

    it("実行名に / を含むと ValidationError を投げる（S3 キー・重複排除 ID を壊さない）", async () => {
      const { deps } = setup();

      await expect(enqueue({ executionName: "a/b" }, deps)).rejects.toThrow(
        ValidationError,
      );
      expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    });

    it("同じ入力で 2 回呼ぶと、2 回とも同じ重複排除 ID で送る（Retry で再投入されても FIFO が除く前提）", async () => {
      const { deps } = setup();

      await enqueue({ executionName: "run-1" }, deps);
      await enqueue({ executionName: "run-1" }, deps);

      const ids = sentEntries().map((entry) => entry.MessageDeduplicationId);
      expect(ids.slice(0, 3)).toEqual(ids.slice(3));
    });

    it("23 件は 10 / 10 / 3 件の 3 回に分けて送る（SendMessageBatch の上限 10 件）", async () => {
      const { deps } = setup(recipientsOf(23));

      await expect(enqueue({ executionName: "run-1" }, deps)).resolves.toEqual({
        enqueued: 23,
      });
      expect(
        sqsMock
          .commandCalls(SendMessageBatchCommand)
          .map((call) => call.args[0].input.Entries?.length),
      ).toEqual([10, 10, 3]);
    });

    it("配信対象が 0 件なら SQS を呼ばずに 0 件を返す（空の Entries は SQS が拒否する）", async () => {
      const { deps } = setup(recipientsOf(0));

      await expect(enqueue({ executionName: "run-1" }, deps)).resolves.toEqual({
        enqueued: 0,
      });
      expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    });

    it("失敗したら、実行名付きのエラーログを 1 行出してから投げ直す", async () => {
      const { deps, records } = setup();

      await expect(
        enqueue({ executionName: "run-1", failAt: "enqueue" }, deps),
      ).rejects.toThrow(InjectedFailureError);

      expect(records()).toEqual([
        expect.objectContaining({
          level: "ERROR",
          message: "投入に失敗しました",
          executionName: "run-1",
          errorName: "InjectedFailureError",
          stack: expect.stringContaining("InjectedFailureError") as unknown,
        }),
      ]);
    });

    it("タスク入力の検証で失敗したら、実行名なしでエラーログを出す", async () => {
      const { deps, records } = setup();

      await expect(enqueue({}, deps)).rejects.toThrow(ValidationError);

      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({
        level: "ERROR",
        errorName: "ValidationError",
      });
      expect(records()[0]).not.toHaveProperty("executionName");
    });
  });

  describe("異常系", () => {
    it("SendMessageBatch の一部が失敗すると、失敗した配信対象 ID を持つ EnqueuePartialFailureError を投げる", async () => {
      sqsMock.on(SendMessageBatchCommand).resolves({
        Successful: [],
        Failed: [{ Id: "r-002", SenderFault: false, Code: "InternalError" }],
      });
      const { deps } = setup();

      const error: unknown = await enqueue(
        { executionName: "run-1" },
        deps,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EnqueuePartialFailureError);
      expect((error as EnqueuePartialFailureError).failedIds).toEqual([
        "r-002",
      ]);
    });

    it("前のバッチで一部が失敗しても後のバッチは送り切り、失敗をまとめて投げる", async () => {
      sqsMock
        .on(SendMessageBatchCommand)
        .resolvesOnce({
          Successful: [],
          Failed: [{ Id: "r-001", SenderFault: false, Code: "InternalError" }],
        })
        .resolves({
          Successful: [],
          Failed: [{ Id: "r-012", SenderFault: false, Code: "InternalError" }],
        });
      const { deps } = setup(recipientsOf(12));

      const error: unknown = await enqueue(
        { executionName: "run-1" },
        deps,
      ).catch((e: unknown) => e);

      expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(2);
      expect((error as EnqueuePartialFailureError).failedIds).toEqual([
        "r-001",
        "r-012",
      ]);
    });

    it("応答に Failed が無ければ成功として扱う", async () => {
      sqsMock.on(SendMessageBatchCommand).resolves({});
      const { deps } = setup();

      await expect(enqueue({ executionName: "run-1" }, deps)).resolves.toEqual({
        enqueued: 3,
      });
    });

    it("失敗エントリに Id が無くても、件数を落とさずに失敗として扱う", async () => {
      // SDK の型では Id は省略可能。実際の SQS は必ず返すが、欠けても失敗を握り潰さないことを確かめる
      sqsMock.on(SendMessageBatchCommand).resolves({
        Failed: [{ Id: undefined, SenderFault: true, Code: "X" }],
      });
      const { deps } = setup();

      const error: unknown = await enqueue(
        { executionName: "run-1" },
        deps,
      ).catch((e: unknown) => e);

      expect((error as EnqueuePartialFailureError).failedIds).toEqual([
        "(ID なし)",
      ]);
    });

    it("SQS の呼び出し自体が失敗すると、その例外をそのまま投げる", async () => {
      sqsMock
        .on(SendMessageBatchCommand)
        .rejects(new Error("QueueDoesNotExist"));
      const { deps } = setup();

      await expect(enqueue({ executionName: "run-1" }, deps)).rejects.toThrow(
        "QueueDoesNotExist",
      );
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

  describe("正常系", () => {
    it("環境変数のキュー URL へ送り、function / stage 付きのログを標準出力へ出す", async () => {
      vi.stubEnv("STAGE", "local");
      vi.stubEnv("QUEUE_URL", QUEUE_URL);

      await expect(handler({ executionName: "run-1" })).resolves.toEqual({
        enqueued: 3,
      });

      expect(
        sqsMock.commandCalls(SendMessageBatchCommand)[0]?.args[0].input
          .QueueUrl,
      ).toBe(QUEUE_URL);
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining('"function":"enqueue","stage":"local"'),
      );
    });
  });

  describe("準正常系", () => {
    it("QUEUE_URL が無ければ ValidationError を投げ、SQS を呼ばない", async () => {
      vi.stubEnv("STAGE", "local");
      vi.stubEnv("QUEUE_URL", undefined);

      await expect(handler({ executionName: "run-1" })).rejects.toThrow(
        ValidationError,
      );
      expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    });

    it.each(["javascript:alert(1)", "file:///etc/passwd", "not a url"])(
      "QUEUE_URL=%s は拒否する",
      async (url) => {
        vi.stubEnv("STAGE", "local");
        vi.stubEnv("QUEUE_URL", url);

        await expect(handler({ executionName: "run-1" })).rejects.toThrow(
          ValidationError,
        );
      },
    );

    it("未定義の STAGE は拒否する", async () => {
      vi.stubEnv("STAGE", "prod");
      vi.stubEnv("QUEUE_URL", QUEUE_URL);

      await expect(handler({ executionName: "run-1" })).rejects.toThrow(
        ValidationError,
      );
    });
  });
});
