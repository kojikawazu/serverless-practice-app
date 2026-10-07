import { describe, expect, it } from "vitest";
import {
  executionInputSchema,
  taskInputSchema,
} from "../../src/schemas/execution";

describe("executionInputSchema（実行入力）", () => {
  describe("正常系", () => {
    it("failAt を省略した入力を受理する（Scheduler の定時起動は {} を渡す）", () => {
      expect(executionInputSchema.parse({})).toEqual({});
    });

    it.each(["enqueue", "dataSync", "consumer"] as const)(
      "failAt=%s を受理する",
      (failAt) => {
        expect(executionInputSchema.parse({ failAt })).toEqual({ failAt });
      },
    );
  });

  describe("準正常系", () => {
    it("未定義の failAt を拒否する", () => {
      expect(executionInputSchema.safeParse({ failAt: "notify" }).success).toBe(
        false,
      );
    });

    it("大文字小文字が違う failAt を拒否する（DataSync は dataSync と別物）", () => {
      expect(
        executionInputSchema.safeParse({ failAt: "DataSync" }).success,
      ).toBe(false);
    });

    it("綴り違いのキー（failat）を「failAt 省略」として通さずに拒否する", () => {
      expect(
        executionInputSchema.safeParse({ failat: "dataSync" }).success,
      ).toBe(false);
    });

    it("failAt が null なら拒否する（省略と null を同一視しない）", () => {
      expect(executionInputSchema.safeParse({ failAt: null }).success).toBe(
        false,
      );
    });
  });

  describe("異常系", () => {
    it.each([null, "dataSync", [], 1])(
      "オブジェクトでない入力 %j を拒否する",
      (input) => {
        expect(executionInputSchema.safeParse(input).success).toBe(false);
      },
    );
  });
});

describe("taskInputSchema（タスク入力）", () => {
  describe("正常系", () => {
    it("実行名と failAt を受理する", () => {
      const input = {
        executionName: "manual-20261008_001",
        failAt: "consumer",
      };

      expect(taskInputSchema.parse(input)).toEqual(input);
    });

    it("Step Functions の上限と同じ 80 文字の実行名を受理する", () => {
      const executionName = "a".repeat(80);

      expect(taskInputSchema.parse({ executionName })).toEqual({
        executionName,
      });
    });
  });

  describe("準正常系", () => {
    it("81 文字の実行名を拒否する", () => {
      expect(
        taskInputSchema.safeParse({ executionName: "a".repeat(81) }).success,
      ).toBe(false);
    });

    it("空の実行名を拒否する", () => {
      expect(taskInputSchema.safeParse({ executionName: "" }).success).toBe(
        false,
      );
    });

    it.each(["a/b", "../x", "a b", "a:b", "ａ"])(
      "S3 のキー・重複排除 ID を壊しうる文字を含む実行名 %j を拒否する",
      (executionName) => {
        expect(taskInputSchema.safeParse({ executionName }).success).toBe(
          false,
        );
      },
    );

    it("実行名が無い入力を拒否する", () => {
      expect(taskInputSchema.safeParse({ failAt: "enqueue" }).success).toBe(
        false,
      );
    });
  });

  describe("異常系", () => {
    it("実行名が文字列でない入力を拒否する", () => {
      expect(taskInputSchema.safeParse({ executionName: 123 }).success).toBe(
        false,
      );
    });
  });
});
