/**
 * 送信記録を書き始めた結果（docs/03「Consumer Lambda」）。前の受信で同じメールを扱ったかを表す。
 */
export type BeginSendResult =
  /** 記録が無かったため「送信中」を書いた。このまま送ってよい */
  | "started"
  /** 送信済みの記録があった。送り直さず、成功として扱う */
  | "sent"
  /** 送信中の記録が残っていた。前の受信で送ったかどうか判定できないため、送らずに失敗として扱う */
  | "unknown";

/**
 * メールの送信記録の口（docs/05「送信記録」）。デモでは DynamoDB が実装する。
 * 記録のキーは `messageKeyOf` で作る `<論理キー>:<配信対象 ID>`（docs/05「論理キー（runKey）」）。
 */
export interface SendRecordStore {
  /**
   * 記録が無ければ「送信中」を書く。あれば書かずに、その状態を返す。
   *
   * @param messageKey - メールのキー
   * @returns 書き始めた結果
   */
  begin(messageKey: string): Promise<BeginSendResult>;

  /**
   * 記録を「送信済み」にする。送った後に呼ぶ。
   *
   * @param messageKey - メールのキー
   */
  markSent(messageKey: string): Promise<void>;

  /**
   * 「送信中」の記録を消す。送れなかったときに呼び、次の受信で送り直せるようにする。
   * 「送信済み」の記録は消さない。
   *
   * @param messageKey - メールのキー
   */
  release(messageKey: string): Promise<void>;
}
