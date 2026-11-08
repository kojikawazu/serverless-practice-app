/**
 * 送信中の記録が残っていて、前の受信でメールを送ったかどうか判定できない（docs/03「Consumer Lambda」）。
 * 送り直すと二重送信になりうるため、送らずにこのエラーで失敗させる。メッセージは最大受信回数で DLQ へ移り、
 * DLQ のアラームで人に知らせる（判定不能を正常値に丸めない。error-handling.md）。
 */
export class SendStateUnknownError extends Error {
  // name を文字列リテラルで固定する理由は ValidationError と同じ
  override readonly name = "SendStateUnknownError";

  /** 判定できなかったメールのキー（`<実行名>:<配信対象 ID>`） */
  readonly messageKey: string;

  /**
   * @param messageKey - 判定できなかったメールのキー
   */
  constructor(messageKey: string) {
    super(
      `送信中の記録が残っており、送信済みか判定できないため送りません: ${messageKey}`,
    );
    this.messageKey = messageKey;
  }
}
