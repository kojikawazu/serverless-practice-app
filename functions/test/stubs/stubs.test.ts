import { describe, expect, it } from "vitest";
import { BigQueryStub } from "../../src/stubs/bigquery-stub";
import { CuenoteFcStub } from "../../src/stubs/cuenote-fc-stub";
import { MySqlStub } from "../../src/stubs/mysql-stub";
import { SendGridStub } from "../../src/stubs/sendgrid-stub";
import { SlackStub } from "../../src/stubs/slack-stub";
import type { Recipient } from "../../src/types/recipient";
import { captureLogger } from "../helpers/log-capture";

const RECIPIENTS: readonly Recipient[] = [
  { recipientId: "r-001", email: "user1@example.com", name: "利用者 1" },
  { recipientId: "r-002", email: "user2@example.com", name: "利用者 2" },
];

describe("MySqlStub", () => {
  describe("正常系", () => {
    it("固定の配信対象 3 件を返す", async () => {
      expect(await new MySqlStub().findAll()).toEqual([
        { recipientId: "r-001", email: "user1@example.com", name: "利用者 1" },
        { recipientId: "r-002", email: "user2@example.com", name: "利用者 2" },
        { recipientId: "r-003", email: "user3@example.com", name: "利用者 3" },
      ]);
    });
  });

  describe("準正常系", () => {
    it("返した配列や要素を書き換えても、次の呼び出しの結果は変わらない", async () => {
      const stub = new MySqlStub();
      // 呼び出し側が戻り値を書き換える状況を再現するため、readonly を外して変更する。
      // 固定データは 3 件あるので first[0] は必ず存在する
      const first = (await stub.findAll()) as Recipient[];
      first[0]!.email = "attacker@evil.test";
      first.pop();

      const second = await stub.findAll();

      expect(second).toHaveLength(3);
      expect(second[0]?.email).toBe("user1@example.com");
    });

    it("すべての宛先が @example.com で、ID が重複しない", async () => {
      const recipients = await new MySqlStub().findAll();

      expect(
        recipients.filter((r) => !r.email.endsWith("@example.com")),
      ).toEqual([]);
      expect(new Set(recipients.map((r) => r.recipientId)).size).toBe(
        recipients.length,
      );
    });
  });
});

describe("SendGridStub", () => {
  describe("正常系", () => {
    it("送信内容を stub=sendgrid のログ 1 行に出す", async () => {
      const { logger, records } = captureLogger({ function: "consumer" });

      await new SendGridStub(logger).send({
        executionName: "run-1",
        recipientId: "r-001",
        to: "user1@example.com",
        subject: "件名",
      });

      expect(records()).toEqual([
        {
          level: "INFO",
          message: "メールを送信しました（スタブ）",
          function: "consumer",
          stub: "sendgrid",
          executionName: "run-1",
          recipientId: "r-001",
          to: "user1@example.com",
          subject: "件名",
        },
      ]);
    });
  });
});

describe("SlackStub", () => {
  describe("正常系", () => {
    it("通知内容を stub=slack のログ 1 行に出す", async () => {
      const { logger, records } = captureLogger({ function: "notify-slack" });

      await new SlackStub(logger).notify({
        executionName: "run-1",
        executionArn:
          "arn:aws:states:ap-northeast-1:000000000000:execution:batch:run-1",
        status: "FAILED",
        error: "InjectedFailureError",
        cause: "原因",
      });

      expect(records()).toEqual([
        {
          level: "INFO",
          message: "実行の失敗を通知しました（スタブ）",
          function: "notify-slack",
          stub: "slack",
          executionName: "run-1",
          executionArn:
            "arn:aws:states:ap-northeast-1:000000000000:execution:batch:run-1",
          status: "FAILED",
          error: "InjectedFailureError",
          cause: "原因",
        },
      ]);
    });
  });

  describe("準正常系", () => {
    it("error と cause が null でも項目を落とさずに null として出す（TIMED_OUT・ABORTED）", async () => {
      const { logger, records } = captureLogger({});

      await new SlackStub(logger).notify({
        executionName: "run-2",
        executionArn: "arn",
        status: "TIMED_OUT",
        error: null,
        cause: null,
      });

      expect(records()[0]).toMatchObject({
        stub: "slack",
        status: "TIMED_OUT",
        error: null,
        cause: null,
      });
    });
  });
});

describe.each([
  [
    "BigQueryStub",
    BigQueryStub,
    "bigquery",
    "BigQuery へ書き込みました（スタブ）",
  ],
  [
    "CuenoteFcStub",
    CuenoteFcStub,
    "cuenote-fc",
    "Cuenote FC へ登録しました（スタブ）",
  ],
])("%s", (_name, Stub, stub, message) => {
  describe("正常系", () => {
    it("書き出し件数と実行名をログ 1 行に出す", async () => {
      const { logger, records } = captureLogger({ function: "data-sync" });

      await new Stub(logger).write("run-1", RECIPIENTS);

      expect(records()).toEqual([
        {
          level: "INFO",
          message,
          function: "data-sync",
          stub,
          executionName: "run-1",
          count: 2,
        },
      ]);
    });
  });

  describe("準正常系", () => {
    it("0 件でも省略せず count=0 を出す（書き出しが呼ばれたことを記録する）", async () => {
      const { logger, records } = captureLogger({});

      await new Stub(logger).write("run-1", []);

      expect(records()[0]).toMatchObject({ stub, count: 0 });
    });

    it("配信対象の個人項目（メールアドレス）をログに出さない", async () => {
      const { logger, lines } = captureLogger({});

      await new Stub(logger).write("run-1", RECIPIENTS);

      expect(lines.join("")).not.toContain("@example.com");
    });
  });
});
