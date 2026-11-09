import { describe, expect, it } from "vitest";
import {
  dataSyncTaskInputSchema,
  taskInputSchema,
} from "../../src/schemas/execution";

describe("taskInputSchema（タスク入力）", () => {
  describe("正常系", () => {
    it("実行名と failAt を受理する", () => {
      const input = {
        executionName: "manual-20261008_001",
        failAt: "consumer",
      };

      expect(taskInputSchema.parse(input)).toEqual(input);
    });

    it("実行名だけの入力を受理する（Scheduler の定時起動は実行入力に {} を渡す）", () => {
      expect(taskInputSchema.parse({ executionName: "run-1" })).toEqual({
        executionName: "run-1",
      });
    });

    it.each(["enqueue", "dataSync", "consumer", "consumerAfterSend"] as const)(
      "failAt=%s を受理する",
      (failAt) => {
        expect(
          taskInputSchema.parse({ executionName: "run-1", failAt }),
        ).toEqual({ executionName: "run-1", failAt });
      },
    );

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

    it("未定義の failAt を拒否する", () => {
      expect(
        taskInputSchema.safeParse({ executionName: "run-1", failAt: "notify" })
          .success,
      ).toBe(false);
    });

    // メッセージ本文の simulateFailure の値（afterSend）を、実行入力の failAt と取り違えて渡しても通さない
    it.each(["afterSend", "consumerAftersend"])(
      "Consumer の失敗の注入に似た、未定義の failAt（%s）を拒否する",
      (failAt) => {
        expect(
          taskInputSchema.safeParse({ executionName: "run-1", failAt }).success,
        ).toBe(false);
      },
    );

    it("大文字小文字が違う failAt を拒否する（DataSync は dataSync と別物）", () => {
      expect(
        taskInputSchema.safeParse({
          executionName: "run-1",
          failAt: "DataSync",
        }).success,
      ).toBe(false);
    });

    it("実行入力の綴り違いのキー（failat）を「failAt 省略」として通さずに拒否する", () => {
      expect(
        taskInputSchema.safeParse({
          executionName: "run-1",
          failat: "dataSync",
        }).success,
      ).toBe(false);
    });

    it("failAt が null なら拒否する（省略と null を同一視しない）", () => {
      expect(
        taskInputSchema.safeParse({ executionName: "run-1", failAt: null })
          .success,
      ).toBe(false);
    });

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

    it.each([null, "run-1", [], 1])(
      "オブジェクトでない入力 %j を拒否する",
      (input) => {
        expect(taskInputSchema.safeParse(input).success).toBe(false);
      },
    );
  });
});

describe("holdSeconds（検証用の待ち時間）", () => {
  describe("正常系", () => {
    it.each([0, 960, 1200])("%d 秒を受理する", (holdSeconds) => {
      expect(
        taskInputSchema.parse({ executionName: "run-1", holdSeconds }),
      ).toEqual({ executionName: "run-1", holdSeconds });
    });
  });

  describe("準正常系", () => {
    it.each([1201, -1, 1.5])(
      "範囲外・小数の %d 秒を拒否する",
      (holdSeconds) => {
        expect(
          taskInputSchema.safeParse({ executionName: "run-1", holdSeconds })
            .success,
        ).toBe(false);
      },
    );
  });

  describe("異常系", () => {
    it.each(["60", null])("数値でない %j を拒否する", (holdSeconds) => {
      expect(
        taskInputSchema.safeParse({ executionName: "run-1", holdSeconds })
          .success,
      ).toBe(false);
    });
  });
});

describe("rerunOf（再実行の元の実行名。#137）", () => {
  describe("正常系", () => {
    it.each(["run-1", "a".repeat(80)])(
      "実行名の制約に合う %j を受理する",
      (rerunOf) => {
        expect(
          taskInputSchema.parse({ executionName: "rerun-1", rerunOf }),
        ).toEqual({ executionName: "rerun-1", rerunOf });
      },
    );

    it("省略を受理し、rerunOf の無い入力として扱う（再実行ではない）", () => {
      expect(taskInputSchema.parse({ executionName: "run-1" })).toEqual({
        executionName: "run-1",
      });
    });
  });

  describe("準正常系", () => {
    it.each(["", "a/b", "a:b", "a".repeat(81)])(
      "実行名の制約に合わない %j を拒否する（送信記録・S3 のキーを壊さない）",
      (rerunOf) => {
        expect(
          taskInputSchema.safeParse({ executionName: "rerun-1", rerunOf })
            .success,
        ).toBe(false);
      },
    );
  });

  describe("異常系", () => {
    it.each([1, null])("文字列でない %j を拒否する", (rerunOf) => {
      expect(
        taskInputSchema.safeParse({ executionName: "rerun-1", rerunOf })
          .success,
      ).toBe(false);
    });
  });
});

describe("dataSyncTaskInputSchema（データ連携 Lambda のタスク入力）", () => {
  describe("正常系", () => {
    it("共通のタスク入力にタスクトークンを足した入力を受理する", () => {
      const input = {
        executionName: "run-1",
        failAt: "dataSync",
        holdSeconds: 60,
        taskToken: "token",
      };

      expect(dataSyncTaskInputSchema.parse(input)).toEqual(input);
    });

    it("SendTask* の上限と同じ 2,048 文字のタスクトークンを受理する", () => {
      expect(
        dataSyncTaskInputSchema.safeParse({
          executionName: "run-1",
          taskToken: "t".repeat(2048),
        }).success,
      ).toBe(true);
    });
  });

  describe("準正常系", () => {
    it.each([
      ["無い", undefined],
      ["空", ""],
      ["2,049 文字", "t".repeat(2049)],
    ])("タスクトークンが%s入力を拒否する", (_label, taskToken) => {
      expect(
        dataSyncTaskInputSchema.safeParse({ executionName: "run-1", taskToken })
          .success,
      ).toBe(false);
    });

    it("共通のタスク入力と同じく、未知のキーを拒否する", () => {
      expect(
        dataSyncTaskInputSchema.safeParse({
          executionName: "run-1",
          taskToken: "token",
          holdsecond: 60,
        }).success,
      ).toBe(false);
    });
  });

  describe("異常系", () => {
    it("共通のタスク入力（投入 Lambda）はタスクトークンを受け付けない", () => {
      expect(
        taskInputSchema.safeParse({
          executionName: "run-1",
          taskToken: "token",
        }).success,
      ).toBe(false);
    });
  });
});
