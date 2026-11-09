import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { ValidationError } from "../../src/errors/validation-error";
import { consume, handler } from "../../src/handlers/consumer";
import type { MailMessage } from "../../src/schemas/mail-message";
import { SendGridStub } from "../../src/stubs/sendgrid-stub";
import type {
  BeginSendResult,
  SendRecordStore,
} from "../../src/types/send-record";
import { captureLogger } from "../helpers/log-capture";

/**
 * 送信記録の偽物。DynamoDB（外部 I/O）の代わりに、キーと状態をメモリに持つ。
 * 条件付きの書き込みの意味（無ければ書く・送信中だけ消す）は本物と同じにし、
 * 失敗させたい操作は `failOn` で指定する。
 */
class InMemorySendRecordStore implements SendRecordStore {
  /** キーごとの状態。テストから前の受信の結果を仕込むためにも使う */
  readonly states = new Map<string, "SENDING" | "SENT">();

  /** 例外を投げさせる操作 */
  failOn = new Set<"begin" | "markSent" | "release">();

  /** @inheritdoc */
  begin(messageKey: string): Promise<BeginSendResult> {
    if (this.failOn.has("begin")) {
      return Promise.reject(new Error("DynamoDB に書けない"));
    }
    const state = this.states.get(messageKey);
    if (state === undefined) {
      this.states.set(messageKey, "SENDING");
      return Promise.resolve("started");
    }
    return Promise.resolve(state === "SENT" ? "sent" : "unknown");
  }

  /** @inheritdoc */
  markSent(messageKey: string): Promise<void> {
    if (this.failOn.has("markSent")) {
      return Promise.reject(new Error("DynamoDB に書けない"));
    }
    this.states.set(messageKey, "SENT");
    return Promise.resolve();
  }

  /** @inheritdoc */
  release(messageKey: string): Promise<void> {
    if (this.failOn.has("release")) {
      return Promise.reject(new Error("DynamoDB から消せない"));
    }
    if (this.states.get(messageKey) === "SENDING") {
      this.states.delete(messageKey);
    }
    return Promise.resolve();
  }
}

/**
 * 有効なメール本文を作る。論理キーは、上書きしなければ実行名と同じ（再実行ではない実行の本文）。
 *
 * @param recipientId - 配信対象 ID（`r-001` 形式）
 * @param overrides - 上書きする項目
 * @returns メール本文
 */
function mail(
  recipientId: string,
  overrides: Partial<MailMessage> = {},
): MailMessage {
  const n = Number(recipientId.slice(2));
  const executionName = overrides.executionName ?? "run-1";
  return {
    executionName,
    runKey: executionName,
    recipientId,
    email: `user${n}@example.com`,
    subject: "件名",
    simulateFailure: "none",
    ...overrides,
  };
}

/**
 * SQS イベントの 1 件を作る。グループ ID は投入 Lambda と同じく配信対象 ID にする。
 *
 * @param messageId - メッセージ ID
 * @param body - 本文。オブジェクトなら JSON にする
 * @param groupId - メッセージグループ ID
 * @returns SQS イベントの 1 件
 */
function record(
  messageId: string,
  body: MailMessage | string,
  groupId?: string,
) {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const group =
    groupId ?? (typeof body === "string" ? messageId : body.recipientId);
  return { messageId, body: bodyText, attributes: { MessageGroupId: group } };
}

/**
 * Consumer の依存を組み立てる。送信先は本物の SendGrid スタブで、ログを捕捉して送信を確かめる。
 * 送信記録はメモリ上の偽物で、受信をまたいで同じものを渡せば再配信を再現できる。
 *
 * @returns 依存・送信記録と、送信されたメールの recipientId・全ログを読む関数
 */
function setup() {
  const { logger, records } = captureLogger({ function: "consumer" });
  const sendRecords = new InMemorySendRecordStore();
  return {
    deps: { mailSender: new SendGridStub(logger), sendRecords, logger },
    sendRecords,
    sentRecipients: () =>
      records()
        .filter((r) => r.stub === "sendgrid")
        .map((r) => r.recipientId),
    records,
  };
}

describe("consume", () => {
  describe("正常系", () => {
    it("5 件すべて送れたら batchItemFailures は空で、5 件ぶん送信される", async () => {
      const { deps, sentRecipients } = setup();
      const ids = ["r-001", "r-002", "r-003", "r-004", "r-005"];

      const result = await consume(
        { Records: ids.map((id, i) => record(`m${i}`, mail(id))) },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [] });
      expect(sentRecipients()).toEqual(ids);
    });

    it("本文の宛先・件名・実行名・論理キーを送信内容に渡す", async () => {
      const { deps, records } = setup();

      await consume(
        {
          Records: [
            record(
              "m1",
              mail("r-001", { executionName: "rerun-1", runKey: "run-1" }),
            ),
          ],
        },
        deps,
      );

      expect(records()[0]).toMatchObject({
        stub: "sendgrid",
        executionName: "rerun-1",
        runKey: "run-1",
        to: "user1@example.com",
        subject: "件名",
      });
    });
  });

  describe("準正常系", () => {
    it("simulateFailure=beforeSend の 1 件だけが失敗し、別グループの他の件は送られる", async () => {
      const { deps, sentRecipients } = setup();

      const result = await consume(
        {
          Records: [
            record("m1", mail("r-001")),
            record("m2", mail("r-002", { simulateFailure: "beforeSend" })),
            record("m3", mail("r-003")),
          ],
        },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
      expect(sentRecipients()).toEqual(["r-001", "r-003"]);
    });

    it("JSON として読めない本文の 1 件だけが失敗し、他は送られる", async () => {
      const { deps, sentRecipients } = setup();

      const result = await consume(
        { Records: [record("m1", "{not json"), record("m2", mail("r-002"))] },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sentRecipients()).toEqual(["r-002"]);
    });

    it("スキーマに合わない本文（@example.com 以外の宛先）は送らずに失敗として返す", async () => {
      const { deps, sentRecipients } = setup();

      const result = await consume(
        {
          Records: [
            record("m1", mail("r-001", { email: "someone@gmail.com" })),
          ],
        },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sentRecipients()).toEqual([]);
    });

    it("失敗したメッセージと同じグループの後続は送らずに失敗として返す（FIFO の順序を守る）", async () => {
      const { deps, sentRecipients } = setup();

      const result = await consume(
        {
          Records: [
            record("m1", mail("r-001", { simulateFailure: "beforeSend" })),
            record("m2", mail("r-002")),
            record("m3", mail("r-001", { executionName: "run-2" })),
          ],
        },
        deps,
      );

      expect(result).toEqual({
        batchItemFailures: [{ itemIdentifier: "m1" }, { itemIdentifier: "m3" }],
      });
      expect(sentRecipients()).toEqual(["r-002"]);
    });

    it("失敗したら messageId・グループ ID・エラー名・スタック付きのエラーログを出す", async () => {
      const { deps, records } = setup();

      await consume(
        {
          Records: [
            record("m1", mail("r-001", { simulateFailure: "beforeSend" })),
          ],
        },
        deps,
      );

      expect(records()).toEqual([
        expect.objectContaining({
          level: "ERROR",
          message: "メッセージの処理に失敗しました",
          messageId: "m1",
          messageGroupId: "r-001",
          errorName: "InjectedFailureError",
          stack: expect.stringContaining("InjectedFailureError") as unknown,
        }),
      ]);
    });

    it("Records が空なら何も送らず、空の batchItemFailures を返す", async () => {
      const { deps, records } = setup();

      await expect(consume({ Records: [] }, deps)).resolves.toEqual({
        batchItemFailures: [],
      });
      expect(records()).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("Records が無いイベントは ValidationError を投げる（バッチ全体を再配信させる）", async () => {
      const { deps } = setup();

      await expect(consume({}, deps)).rejects.toThrow(ValidationError);
    });

    it("グループ ID の無いメッセージが失敗しても、他のグループ ID の無いメッセージは送る", async () => {
      const { deps, sentRecipients } = setup();
      const noGroup = (id: string, body: MailMessage) => ({
        messageId: id,
        body: JSON.stringify(body),
        attributes: {},
      });

      const result = await consume(
        {
          Records: [
            noGroup("m1", mail("r-001", { simulateFailure: "beforeSend" })),
            noGroup("m2", mail("r-002")),
          ],
        },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sentRecipients()).toEqual(["r-002"]);
    });

    it("送信先が例外を投げても、その 1 件の失敗として返し、他のグループは送る", async () => {
      const { logger } = captureLogger({ function: "consumer" });
      const sent: string[] = [];
      const flakySender = {
        send: (m: { recipientId: string }) => {
          if (m.recipientId === "r-001") {
            return Promise.reject(new Error("SendGrid 503"));
          }
          sent.push(m.recipientId);
          return Promise.resolve();
        },
      };

      const result = await consume(
        { Records: [record("m1", mail("r-001")), record("m2", mail("r-002"))] },
        {
          mailSender: flakySender,
          sendRecords: new InMemorySendRecordStore(),
          logger,
        },
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sent).toEqual(["r-002"]);
    });
  });
});

describe("consume（送信記録による二重送信の防止。#136）", () => {
  describe("正常系", () => {
    it("同じメッセージが 2 回届いても、送信は 1 回で、2 回目は送らずに成功として返す", async () => {
      const { deps, sentRecipients, records } = setup();
      const event = { Records: [record("m1", mail("r-001"))] };

      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [],
      });
      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [],
      });

      expect(sentRecipients()).toEqual(["r-001"]);
      expect(records()).toContainEqual(
        expect.objectContaining({
          level: "INFO",
          message: "送信済みのため送りません",
          messageId: "m1",
          messageKey: "run-1:r-001",
        }),
      );
    });

    it("送った後に、送信記録を <実行名>:<配信対象 ID> のキーで送信済みにする", async () => {
      const { deps, sendRecords } = setup();

      await consume({ Records: [record("m1", mail("r-001"))] }, deps);

      expect([...sendRecords.states]).toEqual([["run-1:r-001", "SENT"]]);
    });

    it("論理キーが違えば（run で起動し直した実行）、同じ宛先でも別のメールとして送る", async () => {
      const { deps, sentRecipients } = setup();

      await consume({ Records: [record("m1", mail("r-001"))] }, deps);
      await consume(
        { Records: [record("m2", mail("r-001", { executionName: "run-2" }))] },
        deps,
      );

      expect(sentRecipients()).toEqual(["r-001", "r-001"]);
    });
  });

  describe("準正常系", () => {
    it("simulateFailure=afterSend は、送って送信済みにした後に失敗し、再配信では送らずに成功する", async () => {
      const { deps, sentRecipients, sendRecords } = setup();
      const event = {
        Records: [
          record("m1", mail("r-001", { simulateFailure: "afterSend" })),
        ],
      };

      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [{ itemIdentifier: "m1" }],
      });
      expect(sendRecords.states.get("run-1:r-001")).toBe("SENT");
      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [],
      });

      expect(sentRecipients()).toEqual(["r-001"]);
    });

    it("送信中の記録が残っていたら、送らずに SendStateUnknownError で失敗として返す", async () => {
      const { deps, sentRecipients, sendRecords, records } = setup();
      sendRecords.states.set("run-1:r-001", "SENDING");

      const result = await consume(
        { Records: [record("m1", mail("r-001"))] },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sentRecipients()).toEqual([]);
      expect(sendRecords.states.get("run-1:r-001")).toBe("SENDING");
      expect(records()).toContainEqual(
        expect.objectContaining({
          level: "ERROR",
          errorName: "SendStateUnknownError",
        }),
      );
    });

    it("simulateFailure=beforeSend は送信記録を書かない（再配信でも判定不能にならず、同じ失敗を繰り返す）", async () => {
      const { deps, sendRecords } = setup();

      await consume(
        {
          Records: [
            record("m1", mail("r-001", { simulateFailure: "beforeSend" })),
          ],
        },
        deps,
      );

      expect(sendRecords.states.size).toBe(0);
    });
  });

  describe("異常系", () => {
    it("送信が失敗したら送信中の記録を消し、次の受信で送り直せる", async () => {
      const { logger, records } = captureLogger({ function: "consumer" });
      const sendRecords = new InMemorySendRecordStore();
      let attempts = 0;
      const flakySender = {
        send: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error("SendGrid 503"))
            : Promise.resolve();
        },
      };
      const deps = { mailSender: flakySender, sendRecords, logger };
      const event = { Records: [record("m1", mail("r-001"))] };

      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [{ itemIdentifier: "m1" }],
      });
      expect(sendRecords.states.size).toBe(0);
      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [],
      });

      expect(attempts).toBe(2);
      expect(sendRecords.states.get("run-1:r-001")).toBe("SENT");
      expect(records()).not.toContainEqual(
        expect.objectContaining({ message: "送信中の記録を消せませんでした" }),
      );
    });

    it("送信記録を書けなければ、送らずに失敗として返す", async () => {
      const { deps, sentRecipients, sendRecords } = setup();
      sendRecords.failOn.add("begin");

      const result = await consume(
        { Records: [record("m1", mail("r-001"))] },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sentRecipients()).toEqual([]);
    });

    it("送信が失敗し、送信中の記録も消せなければ、元の失敗として返し、消せなかったことをエラーログに出す", async () => {
      const { logger, records } = captureLogger({ function: "consumer" });
      const sendRecords = new InMemorySendRecordStore();
      sendRecords.failOn.add("release");
      const failingSender = {
        send: () => Promise.reject(new Error("SendGrid 503")),
      };

      const result = await consume(
        { Records: [record("m1", mail("r-001"))] },
        { mailSender: failingSender, sendRecords, logger },
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(records()).toContainEqual(
        expect.objectContaining({
          level: "ERROR",
          message: "送信中の記録を消せませんでした",
          messageKey: "run-1:r-001",
        }),
      );
      expect(records()).toContainEqual(
        expect.objectContaining({
          message: "メッセージの処理に失敗しました",
          errorMessage: "SendGrid 503",
        }),
      );
      // 送信中が残るため、次の受信は送り直さずに判定不能になる
      expect(sendRecords.states.get("run-1:r-001")).toBe("SENDING");
    });

    it("送った後に送信済みにできなければ失敗として返し、次の受信では送り直さない", async () => {
      const { deps, sentRecipients, sendRecords } = setup();
      sendRecords.failOn.add("markSent");
      const event = { Records: [record("m1", mail("r-001"))] };

      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [{ itemIdentifier: "m1" }],
      });
      sendRecords.failOn.clear();
      await expect(consume(event, deps)).resolves.toEqual({
        batchItemFailures: [{ itemIdentifier: "m1" }],
      });

      expect(sentRecipients()).toEqual(["r-001"]);
    });
  });
});

describe("consume（再実行で、送れていたメールを送らない。#137）", () => {
  /** 最初の実行 run-1 を、rerun-1 として再実行したときの本文 */
  const rerunMail = (recipientId: string) =>
    mail(recipientId, { executionName: "rerun-1", runKey: "run-1" });

  describe("正常系", () => {
    it("送信記録のキーを、実行名ではなく <論理キー>:<配信対象 ID> で作る", async () => {
      const { deps, sendRecords } = setup();

      await consume({ Records: [record("m1", rerunMail("r-001"))] }, deps);

      expect([...sendRecords.states]).toEqual([["run-1:r-001", "SENT"]]);
    });

    it("同じ論理キーで送信済みの宛先は、実行名が違っても送らずに成功し、記録の無い宛先は送る", async () => {
      const { deps, sentRecipients, sendRecords, records } = setup();
      // 最初の実行で r-001 だけ送れていた
      sendRecords.states.set("run-1:r-001", "SENT");

      const result = await consume(
        {
          Records: [
            record("m1", rerunMail("r-001")),
            record("m2", rerunMail("r-002")),
          ],
        },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [] });
      expect(sentRecipients()).toEqual(["r-002"]);
      expect(records()).toContainEqual(
        expect.objectContaining({
          message: "送信済みのため送りません",
          messageKey: "run-1:r-001",
        }),
      );
    });
  });

  describe("準正常系", () => {
    it("同じ論理キーの送信中の記録が残っていたら、再実行のメッセージでも送らずに SendStateUnknownError で失敗させる", async () => {
      const { deps, sentRecipients, sendRecords, records } = setup();
      sendRecords.states.set("run-1:r-001", "SENDING");

      const result = await consume(
        { Records: [record("m1", rerunMail("r-001"))] },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sentRecipients()).toEqual([]);
      expect(sendRecords.states.get("run-1:r-001")).toBe("SENDING");
      expect(records()).toContainEqual(
        expect.objectContaining({ errorName: "SendStateUnknownError" }),
      );
    });

    it("runKey の無い本文（#137 より前に積まれたもの）は、送らずに失敗として返す", async () => {
      const { deps, sentRecipients, sendRecords } = setup();
      const { runKey: _omitted, ...legacy } = mail("r-001");

      const result = await consume(
        { Records: [record("m1", JSON.stringify(legacy), "r-001")] },
        deps,
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sentRecipients()).toEqual([]);
      expect(sendRecords.states.size).toBe(0);
    });
  });
});

describe("handler（Lambda の入口）", () => {
  // 標準出力と DynamoDB（外部 I/O）だけを差し替え、出力された行と DynamoDB への呼び出しを検証する
  let stdoutWrite: MockInstance<typeof process.stdout.write>;
  const dynamodbMock = mockClient(DynamoDBClient);

  beforeEach(() => {
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    dynamodbMock.reset();
    dynamodbMock.on(PutItemCommand).resolves({});
    dynamodbMock.on(UpdateItemCommand).resolves({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("function / stage 付きのロガーで送信し、環境変数のテーブルに送信記録を書く", async () => {
    vi.stubEnv("STAGE", "dev");
    vi.stubEnv(
      "SEND_RECORDS_TABLE",
      "serverless-practice-app-dev-send-records",
    );

    await expect(
      handler({ Records: [record("m1", mail("r-001"))] }),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining(
        '"function":"consumer","stage":"dev","stub":"sendgrid"',
      ),
    );
    expect(
      dynamodbMock.commandCalls(PutItemCommand)[0]?.args[0].input.TableName,
    ).toBe("serverless-practice-app-dev-send-records");
  });

  it("STAGE が無ければ ValidationError を投げる", async () => {
    vi.stubEnv("STAGE", undefined);
    vi.stubEnv(
      "SEND_RECORDS_TABLE",
      "serverless-practice-app-dev-send-records",
    );

    await expect(handler({ Records: [] })).rejects.toThrow(ValidationError);
  });

  it("SEND_RECORDS_TABLE が無ければ ValidationError を投げる", async () => {
    vi.stubEnv("STAGE", "dev");
    vi.stubEnv("SEND_RECORDS_TABLE", undefined);

    await expect(handler({ Records: [] })).rejects.toThrow(ValidationError);
  });
});
