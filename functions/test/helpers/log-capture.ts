import { createLogger } from "../../src/lib/logger";
import type { LogFields, Logger } from "../../src/types/logger";

/**
 * 出力を配列へ溜めるロガーを作る。`console` や `process.stdout` をモックせず、
 * ロガーの出力先（sink）だけを差し替えて、本物の整形処理を通した行を検証する。
 *
 * @param fields - ロガーの共通項目
 * @returns ロガーと、出力された行を JSON として読む関数
 */
export function captureLogger(fields: LogFields = { function: "test" }): {
  logger: Logger;
  lines: string[];
  records: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = createLogger(fields, (line) => lines.push(line));
  return {
    logger,
    lines,
    records: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
