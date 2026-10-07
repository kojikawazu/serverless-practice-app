import { describe, expect, it } from "vitest";
import { mailMessageSchema } from "../../src/schemas/mail-message";

/** 検証を通る本文。各ケースはここから 1 項目だけ変えて境界を確かめる */
const VALID = {
  executionName: "manual-20261008-001",
  recipientId: "r-001",
  email: "user1@example.com",
  subject: "serverless-practice-app デモ配信",
  simulateFailure: false,
};

describe("mailMessageSchema（SQS メッセージ本文）", () => {
  describe("正常系", () => {
    it("全項目がそろった本文を受理する", () => {
      expect(mailMessageSchema.parse(VALID)).toEqual(VALID);
    });

    it("simulateFailure が true の本文を受理する", () => {
      expect(
        mailMessageSchema.parse({ ...VALID, simulateFailure: true }),
      ).toEqual({
        ...VALID,
        simulateFailure: true,
      });
    });
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

    it('文字列の "true" を simulateFailure として受理しない', () => {
      expect(
        mailMessageSchema.safeParse({ ...VALID, simulateFailure: "true" })
          .success,
      ).toBe(false);
    });
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
