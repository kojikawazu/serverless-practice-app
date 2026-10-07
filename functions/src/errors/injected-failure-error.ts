import type { FailAt } from "../schemas/execution";

/**
 * 実行入力の `failAt` で意図的に注入した失敗を表すエラー。Step Functions の `Retry` の対象にしない
 * （docs/02「F-6: 失敗の注入」）。
 */
export class InjectedFailureError extends Error {
  // name を文字列リテラルで固定する理由は ValidationError と同じ
  override readonly name = "InjectedFailureError";

  /** 失敗を注入した箇所 */
  readonly failAt: FailAt;

  /**
   * @param failAt - 失敗を注入した箇所
   */
  constructor(failAt: FailAt) {
    super(`failAt=${failAt} の指定により失敗を注入しました`);
    this.failAt = failAt;
  }
}
