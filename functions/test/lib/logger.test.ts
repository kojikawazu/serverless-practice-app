import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/lib/logger";
import { captureLogger } from "../helpers/log-capture";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("正常系", () => {
    it("1 回の呼び出しで、レベル・本文・共通項目・追加項目を持つ JSON を 1 行出す", () => {
      const { logger, lines, records } = captureLogger({ function: "enqueue" });

      logger.info("投入しました", { count: 3 });

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("\n");
      expect(records()).toEqual([
        {
          level: "INFO",
          message: "投入しました",
          function: "enqueue",
          count: 3,
        },
      ]);
    });

    it("child で足した項目が以降の行に付き、元のロガーには付かない", () => {
      const { logger, records } = captureLogger({ function: "consumer" });

      logger.child({ executionName: "run-1" }).info("子");
      logger.info("親");

      expect(records()).toEqual([
        {
          level: "INFO",
          message: "子",
          function: "consumer",
          executionName: "run-1",
        },
        { level: "INFO", message: "親", function: "consumer" },
      ]);
    });

    it("出力先を省略すると、標準出力へ改行付きで書く", () => {
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      createLogger({ function: "notify-slack" }).info("標準出力");

      expect(write).toHaveBeenCalledExactlyOnceWith(
        `${JSON.stringify({ level: "INFO", message: "標準出力", function: "notify-slack" })}\n`,
      );
    });
  });

  describe("準正常系", () => {
    it("同じキーは後から足したものが優先される（共通 < child < 呼び出し時）", () => {
      const { logger, records } = captureLogger({
        function: "a",
        stage: "local",
      });

      logger.child({ stage: "dev" }).info("上書き", { function: "b" });

      expect(records()).toEqual([
        { level: "INFO", message: "上書き", function: "b", stage: "dev" },
      ]);
    });

    it("項目で level / message を渡しても上書きされない", () => {
      const { logger, records } = captureLogger({ level: "DEBUG" });

      logger.info("本文", { message: "偽の本文", level: "ERROR" });

      expect(records()).toEqual([{ level: "INFO", message: "本文" }]);
    });

    it("undefined の項目は出力しない", () => {
      const { logger, records } = captureLogger({});

      logger.info("本文", { error: undefined, cause: null });

      expect(records()).toEqual([
        { level: "INFO", message: "本文", cause: null },
      ]);
    });
  });

  describe("error", () => {
    it("エラーの名前・メッセージ・スタックトレースを ERROR の 1 行に出す", () => {
      const { logger, records } = captureLogger({ function: "enqueue" });
      const error = new TypeError("壊れた");

      logger.error("失敗しました", error, { messageId: "m1" });

      expect(records()).toEqual([
        {
          level: "ERROR",
          message: "失敗しました",
          function: "enqueue",
          messageId: "m1",
          errorName: "TypeError",
          errorMessage: "壊れた",
          stack: error.stack,
        },
      ]);
    });

    it("Error 以外の値が投げられても、文字列にしてメッセージに入れる", () => {
      const { logger, records } = captureLogger({});

      logger.error("失敗しました", "文字列を throw した");

      expect(records()).toEqual([
        {
          level: "ERROR",
          message: "失敗しました",
          errorName: "NonError",
          errorMessage: "文字列を throw した",
        },
      ]);
    });

    it("呼び出し時の項目でエラーの名前を上書きできない", () => {
      const { logger, records } = captureLogger({});

      logger.error("失敗しました", new RangeError("x"), { errorName: "偽装" });

      expect(records()[0]?.errorName).toBe("RangeError");
    });
  });

  describe("異常系", () => {
    it("循環参照を含む項目でも例外を投げず、失敗を示す行を 1 行出す", () => {
      const { logger, records } = captureLogger({ function: "x" });
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => logger.info("循環", { circular })).not.toThrow();

      const [record] = records();
      expect(record).toMatchObject({ level: "INFO", message: "循環" });
      expect(record?.logError).toMatch(
        /^ログ項目を JSON にできませんでした: TypeError/,
      );
      expect(record).not.toHaveProperty("circular");
    });

    it("BigInt を含む項目でも例外を投げず、失敗を示す行を出す", () => {
      const { logger, records } = captureLogger({});

      expect(() => logger.info("BigInt", { size: 10n })).not.toThrow();
      expect(records()[0]?.logError).toMatch(/BigInt/);
    });
  });
});
