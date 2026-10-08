import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors/validation-error";
import { loadHandlerContext } from "../../src/lib/handler-context";
import { dataSyncEnvSchema } from "../../src/schemas/env";

describe("loadHandlerContext", () => {
  describe("正常系", () => {
    it("検証済みの環境変数を返し、余分な環境変数は取り除く", () => {
      const { env } = loadHandlerContext("data-sync", dataSyncEnvSchema, {
        STAGE: "dev",
        BUCKET_NAME: "bucket-1",
        AWS_REGION: "ap-northeast-1",
      });

      expect(env).toEqual({ STAGE: "dev", BUCKET_NAME: "bucket-1" });
    });
  });

  describe("準正常系", () => {
    it("必要な環境変数が欠けていれば ValidationError を投げる", () => {
      expect(() =>
        loadHandlerContext("data-sync", dataSyncEnvSchema, { STAGE: "dev" }),
      ).toThrow(ValidationError);
    });

    it("エラーメッセージで、環境変数の検証に失敗したことと項目名が分かる", () => {
      expect(() =>
        loadHandlerContext("data-sync", dataSyncEnvSchema, { STAGE: "dev" }),
      ).toThrow(/^環境変数が不正です: [\s\S]*BUCKET_NAME/);
    });
  });
});
