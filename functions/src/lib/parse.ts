import type { z } from "zod";
import { ValidationError } from "../errors/validation-error";

/**
 * 外部入力を `unknown` のまま受け取り、スキーマで検証して型付きの値を返す。
 * handler の入口で使い、検証済みの値だけを後段へ渡す。
 *
 * @param schema - 検証に使う Zod スキーマ
 * @param input - 検証する値（イベント・メッセージ本文など）
 * @param target - 入力の名前。エラーメッセージの先頭に付ける（例: `実行入力`）
 * @returns スキーマを通過した値。未知のキーを取り除くスキーマでは取り除いた後の値
 * @throws {ValidationError} 入力がスキーマに合わない場合
 */
export function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  target: string,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(target, result.error);
  }
  return result.data;
}
