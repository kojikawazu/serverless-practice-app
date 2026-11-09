import { describe, expect, it } from "vitest";
import { mailMessageSchema } from "../../src/schemas/mail-message";

/** 検証を通る本文。各ケースはここから 1 項目だけ変えて境界を確かめる */
const VALID = {
  executionName: "manual-20261008-001",
  runKey: "manual-20261008-001",
  recipientId: "r-001",
  email: "user1@example.com",
  subject: "serverless-practice-app デモ配信",
  simulateFailure: "none",
};

describe("mailMessageSchema の runKey（論理キー。#137）", () => {
  describe("正常系", () => {
    it.each(["rerun-1", "a".repeat(80)])(
      "実行名と違う値・80 文字の runKey %j を受理する",
      (runKey) => {
        expect(mailMessageSchema.parse({ ...VALID, runKey }).runKey).toBe(
          runKey,
        );
      },
    );
  });

  describe("準正常系", () => {
    it.each(["", "a/b", "a:b", "a".repeat(81)])(
      "実行名の制約に合わない runKey %j を拒否する（送信記録のキーを壊さない）",
      (runKey) => {
        expect(mailMessageSchema.safeParse({ ...VALID, runKey }).success).toBe(
          false,
        );
      },
    );

    it("runKey の無い本文（#137 より前に積まれたもの）を拒否する", () => {
      const { runKey: _omitted, ...legacy } = VALID;
      expect(mailMessageSchema.safeParse(legacy).success).toBe(false);
    });
  });

  describe("異常系", () => {
    it.each([1, null])("文字列でない runKey %j を拒否する", (runKey) => {
      expect(mailMessageSchema.safeParse({ ...VALID, runKey }).success).toBe(
        false,
      );
    });
  });
});

describe("mailMessageSchema（SQS メッセージ本文）", () => {
  describe("正常系", () => {
    it("全項目がそろった本文を受理する", () => {
      expect(mailMessageSchema.parse(VALID)).toEqual(VALID);
    });

    it.each(["none", "beforeSend", "afterSend"])(
      "simulateFailure が %s の本文を受理する",
      (simulateFailure) => {
        expect(mailMessageSchema.parse({ ...VALID, simulateFailure })).toEqual({
          ...VALID,
          simulateFailure,
        });
      },
    );
  });

  describe("準正常系", () => {
    it.each([
      "user1@gmail.com",
      "user1@example.com.evil.test",
      "user1@sub.example.org",
    ])(
      "@example.com 以外の宛先 %j を拒否する（実在の宛先を扱わない）",
      (email) => {
        expect(mailMessageSchema.safeParse({ ...VALID, email }).success).toBe(
          false,
        );
      },
    );

    it("メールアドレスの形式でない宛先を拒否する", () => {
      expect(
        mailMessageSchema.safeParse({ ...VALID, email: "@example.com" })
          .success,
      ).toBe(false);
    });

    it.each(["r-1", "r-0001", "x-001", ""])(
      "形式の違う配信対象 ID %j を拒否する",
      (recipientId) => {
        expect(
          mailMessageSchema.safeParse({ ...VALID, recipientId }).success,
        ).toBe(false);
      },
    );

    it("空の件名を拒否する", () => {
      expect(
        mailMessageSchema.safeParse({ ...VALID, subject: "" }).success,
      ).toBe(false);
    });

    // 真偽値だった頃（#136 より前）の本文は、どちらの失敗を注入するか読めないため受理しない
    it.each([true, false, "true", "consumer", "AfterSend"])(
      "simulateFailure が %s の本文を受理しない",
      (simulateFailure) => {
        expect(
          mailMessageSchema.safeParse({ ...VALID, simulateFailure }).success,
        ).toBe(false);
      },
    );
  });

  describe("異常系", () => {
    it("項目が欠けた本文を拒否する", () => {
      const { simulateFailure: _omitted, ...withoutFlag } = VALID;

      expect(mailMessageSchema.safeParse(withoutFlag).success).toBe(false);
    });

    it("未知の項目を含む本文を拒否する", () => {
      expect(
        mailMessageSchema.safeParse({ ...VALID, cc: "x@example.com" }).success,
      ).toBe(false);
    });
  });
});
