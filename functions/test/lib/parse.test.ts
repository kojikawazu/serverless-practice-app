import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors/validation-error";
import { parseInput } from "../../src/lib/parse";
import { taskInputSchema } from "../../src/schemas/execution";
import { executionStatusEventSchema } from "../../src/schemas/execution-status-event";

describe("parseInput", () => {
  describe("正常系", () => {
    it("スキーマを通過した値を返す", () => {
      expect(
        parseInput(
          taskInputSchema,
          { executionName: "run-1", failAt: "enqueue" },
          "タスク入力",
        ),
      ).toEqual({ executionName: "run-1", failAt: "enqueue" });
    });
  });

  describe("準正常系", () => {
    it("スキーマに合わない入力で ValidationError を投げる", () => {
      expect(() =>
        parseInput(
          taskInputSchema,
          { executionName: "run-1", failAt: "x" },
          "タスク入力",
        ),
      ).toThrow(ValidationError);
    });

    it("エラーメッセージの先頭に入力の名前を付け、失敗した項目名を含める", () => {
      expect(() =>
        parseInput(
          taskInputSchema,
          { executionName: "run-1", failAt: "x" },
          "タスク入力",
        ),
      ).toThrow(/^タスク入力が不正です: [\s\S]*failAt/);
    });

    it("検証に失敗した箇所を issues に保持する", () => {
      let caught: unknown;
      try {
        parseInput(
          taskInputSchema,
          { executionName: "run-1", failAt: "x" },
          "タスク入力",
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ValidationError);
      expect(
        (caught as ValidationError).issues.map((issue) => issue.path),
      ).toEqual([["failAt"]]);
    });
  });

  describe("異常系", () => {
    it("undefined の入力でも型エラーではなく ValidationError を投げる", () => {
      expect(() =>
        parseInput(executionStatusEventSchema, undefined, "状態変化イベント"),
      ).toThrow(ValidationError);
    });
  });
});
