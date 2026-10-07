import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnqueuePartialFailureError } from "../../src/errors/enqueue-partial-failure-error";
import { InjectedFailureError } from "../../src/errors/injected-failure-error";
import { ValidationError } from "../../src/errors/validation-error";

// エラー名は Step Functions の Retry と実行結果の error で使う契約（docs/07「認証・エラーハンドリング」）。
// 期待値は文字列で直書きする。クラス名から導出すると、名前の変更をテストが追従してしまい検出できない。

describe("エラークラス", () => {
  describe("正常系", () => {
    it("InjectedFailureError は名前・注入箇所・メッセージを持つ", () => {
      const error = new InjectedFailureError("dataSync");

      expect(error.name).toBe("InjectedFailureError");
      expect(error.failAt).toBe("dataSync");
      expect(error.message).toBe(
        "failAt=dataSync の指定により失敗を注入しました",
      );
    });

    it("EnqueuePartialFailureError は名前・失敗した ID・件数入りのメッセージを持つ", () => {
      const error = new EnqueuePartialFailureError(["0", "2"]);

      expect(error.name).toBe("EnqueuePartialFailureError");
      expect(error.failedIds).toEqual(["0", "2"]);
      expect(error.message).toBe(
        "SendMessageBatch で 2 件の送信に失敗しました: 0, 2",
      );
    });

    it("ValidationError は名前と検証の失敗箇所を持つ", () => {
      const result = z.object({ a: z.string() }).safeParse({ a: 1 });
      if (result.success) {
        throw new Error("前提: 検証が失敗する入力を使う");
      }

      const error = new ValidationError("テスト入力", result.error);

      expect(error.name).toBe("ValidationError");
      expect(error.issues.map((issue) => issue.path)).toEqual([["a"]]);
    });
  });

  describe("準正常系", () => {
    it.each([
      ["InjectedFailureError", () => new InjectedFailureError("enqueue")],
      [
        "EnqueuePartialFailureError",
        () => new EnqueuePartialFailureError(["0"]),
      ],
    ])(
      "%s は Error として扱え、スタックトレースを持つ（ログ出力の前提）",
      (_name, create) => {
        const error = create();

        expect(error).toBeInstanceOf(Error);
        expect(error.stack).toContain(error.name);
      },
    );

    it("JSON にしても名前が失われない（Lambda がエラーを返すときの errorType の元）", () => {
      const error = new InjectedFailureError("consumer");

      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        name: "InjectedFailureError",
        failAt: "consumer",
      });
    });
  });
});
