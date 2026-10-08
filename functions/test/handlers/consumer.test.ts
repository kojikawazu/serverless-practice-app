import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { ValidationError } from "../../src/errors/validation-error";
import { consume, handler } from "../../src/handlers/consumer";
import type { MailMessage } from "../../src/schemas/mail-message";
import { SendGridStub } from "../../src/stubs/sendgrid-stub";
import { captureLogger } from "../helpers/log-capture";

/**
 * 有効なメール本文を作る。
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
  return {
    executionName: "run-1",
    recipientId,
    email: `user${n}@example.com`,
    subject: "件名",
    simulateFailure: false,
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
 *
 * @returns 依存と、送信されたメールの recipientId・全ログを読む関数
 */
function setup() {
  const { logger, records } = captureLogger({ function: "consumer" });
  return {
    deps: { mailSender: new SendGridStub(logger), logger },
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

    it("本文の宛先・件名・実行名を送信内容に渡す", async () => {
      const { deps, records } = setup();

      await consume({ Records: [record("m1", mail("r-001"))] }, deps);

      expect(records()[0]).toMatchObject({
        stub: "sendgrid",
        executionName: "run-1",
        to: "user1@example.com",
        subject: "件名",
      });
    });
  });

  describe("準正常系", () => {
    it("simulateFailure=true の 1 件だけが失敗し、別グループの他の件は送られる", async () => {
      const { deps, sentRecipients } = setup();

      const result = await consume(
        {
          Records: [
            record("m1", mail("r-001")),
            record("m2", mail("r-002", { simulateFailure: true })),
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
            record("m1", mail("r-001", { simulateFailure: true })),
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
        { Records: [record("m1", mail("r-001", { simulateFailure: true }))] },
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
            noGroup("m1", mail("r-001", { simulateFailure: true })),
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
        { mailSender: flakySender, logger },
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(sent).toEqual(["r-002"]);
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

  it("function / stage 付きのロガーで送信する", async () => {
    vi.stubEnv("STAGE", "dev");

    await expect(
      handler({ Records: [record("m1", mail("r-001"))] }),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining(
        '"function":"consumer","stage":"dev","stub":"sendgrid"',
      ),
    );
  });

  it("STAGE が無ければ ValidationError を投げる", async () => {
    vi.stubEnv("STAGE", undefined);

    await expect(handler({ Records: [] })).rejects.toThrow(ValidationError);
  });
});
