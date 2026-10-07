/**
 * `SendMessageBatch` の一部のメッセージが送れなかったことを表すエラー。
 * Step Functions の `Retry` の対象にする。再送しても重複排除 ID が決定的なため、
 * 送信済みの分は 5 分以内なら重複しない（docs/05「メールメッセージ」）。
 */
export class EnqueuePartialFailureError extends Error {
  // name を文字列リテラルで固定する理由は ValidationError と同じ
  override readonly name = "EnqueuePartialFailureError";

  /** 送れなかったメッセージのバッチ内 ID。呼び出し側は失敗が 1 件以上あるときだけこのエラーを作る */
  readonly failedIds: readonly string[];

  /**
   * @param failedIds - 送れなかったメッセージのバッチ内 ID
   */
  constructor(failedIds: readonly string[]) {
    super(
      `SendMessageBatch で ${failedIds.length} 件の送信に失敗しました: ${failedIds.join(", ")}`,
    );
    this.failedIds = failedIds;
  }
}
