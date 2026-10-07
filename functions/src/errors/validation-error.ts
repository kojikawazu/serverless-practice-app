import { z } from "zod";

/**
 * 入力がスキーマに合わないことを表すエラー。Step Functions の `Retry` の対象にしない
 * （何度やり直しても同じ入力で同じ結果になるため。docs/07「認証・エラーハンドリング」）。
 */
export class ValidationError extends Error {
  // Step Functions は errorType（= name）で Retry を判定する。minify でクラス名が変わっても
  // 契約が崩れないよう、constructor.name ではなく文字列リテラルで固定する
  override readonly name = "ValidationError";

  /** 検証に失敗した箇所の一覧。ログで原因を特定するために保持する */
  readonly issues: readonly z.core.$ZodIssue[];

  /**
   * @param target - 検証した入力の名前（例: `実行入力`）。メッセージの先頭に付ける
   * @param error - Zod が返した検証エラー
   */
  constructor(target: string, error: z.ZodError) {
    super(`${target}が不正です: ${z.prettifyError(error)}`);
    this.issues = error.issues;
  }
}
