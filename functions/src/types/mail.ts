/**
 * 1 通分の送信内容。SQS のメッセージ本文（`MailMessage`）から、送信に要る項目だけを取り出したもの。
 * 失敗の注入フラグなど、キュー側の都合の項目は持たない。
 */
export type OutgoingMail = {
  /** 投入したステートマシンの実行名。ログで実行を横断して追うために使う */
  executionName: string;
  recipientId: string;
  /** 宛先メールアドレス */
  to: string;
  subject: string;
};

/**
 * メールを送る口。本番構成では SendGrid、デモではスタブが実装する。
 */
export interface MailSender {
  /**
   * 1 通送る。
   *
   * @param mail - 送信内容
   */
  send(mail: OutgoingMail): Promise<void>;
}
