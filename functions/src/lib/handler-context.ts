import type { z } from "zod";
import type { BaseEnv } from "../schemas/env";
import type { Logger } from "../types/logger";
import { createLogger } from "./logger";
import { parseInput } from "./parse";

/**
 * Lambda の関数名。ログの `function` 項目と、AWS リソース名の `<name>` 部分に使う（docs/10「命名」）。
 */
type FunctionName = "enqueue" | "consumer" | "data-sync" | "notify-slack";

/**
 * Lambda の入口で使う、検証済みの環境変数とロガー。
 */
type HandlerContext<E extends BaseEnv> = {
  /** 検証済みの環境変数 */
  env: E;
  /** `function` と `stage` を共通項目に持つロガー */
  logger: Logger;
};

/**
 * Lambda の入口で、環境変数を検証してロガーを組み立てる。
 * 全 handler のログに同じ共通項目（`function` / `stage`）を付けるための 1 箇所。
 *
 * @param functionName - Lambda の関数名
 * @param envSchema - その Lambda の環境変数のスキーマ。`STAGE` を含む
 * @param env - 検証する環境変数。省略時は `process.env`
 * @returns 検証済みの環境変数とロガー
 * @throws {ValidationError} 環境変数がスキーマに合わない場合
 */
export function loadHandlerContext<E extends BaseEnv>(
  functionName: FunctionName,
  envSchema: z.ZodType<E>,
  env: unknown = process.env,
): HandlerContext<E> {
  const parsed = parseInput(envSchema, env, "環境変数");
  return {
    env: parsed,
    logger: createLogger({ function: functionName, stage: parsed.STAGE }),
  };
}
