import type { LogFields, LogSink, Logger } from "../types/logger";

/**
 * 標準出力へ 1 行ずつ書く出力先。Lambda では標準出力がそのまま CloudWatch Logs に入る。
 * `console.log` はテキスト形式のログで時刻やリクエスト ID を前置きし、行が純粋な JSON でなくなるため使わない。
 *
 * @param line - 出力する 1 行分の JSON
 */
function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 1 行分の JSON を組み立てる。`level` / `message` は呼び出し側の項目で上書きさせない。
 * 直列化できない値（循環参照・BigInt）を含む場合は、元の項目を捨てて失敗を示す行を返す。
 *
 * @param level - ログレベル
 * @param message - ログの本文
 * @param fields - 共通項目と呼び出し時の項目を合わせたもの
 * @returns 改行を含まない JSON 文字列
 */
function formatLine(level: string, message: string, fields: LogFields): string {
  const { level: _level, message: _message, ...rest } = fields;
  try {
    return JSON.stringify({ level, message, ...rest });
  } catch (error) {
    return JSON.stringify({
      level,
      message,
      logError: `ログ項目を JSON にできませんでした: ${String(error)}`,
    });
  }
}

/**
 * 投げられた値をログ項目にする。`Error` 以外（文字列・オブジェクト）が投げられても情報を落とさない。
 *
 * @param error - 投げられた値
 * @returns エラーの名前・メッセージ・スタックトレース
 */
function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return { errorName: "NonError", errorMessage: String(error) };
}

/**
 * 構造化ロガーを作る。
 *
 * @param fields - すべての行に付ける共通項目（例: `{ function: "enqueue" }`）
 * @param sink - 出力先。省略時は標準出力
 * @returns ロガー
 */
export function createLogger(
  fields: LogFields,
  sink: LogSink = writeStdout,
): Logger {
  return {
    info: (message, extra = {}) => {
      sink(formatLine("INFO", message, { ...fields, ...extra }));
    },
    warn: (message, extra = {}) => {
      sink(formatLine("WARN", message, { ...fields, ...extra }));
    },
    error: (message, error, extra = {}) => {
      sink(
        formatLine("ERROR", message, {
          ...fields,
          ...extra,
          ...errorFields(error),
        }),
      );
    },
    child: (childFields) => createLogger({ ...fields, ...childFields }, sink),
  };
}
