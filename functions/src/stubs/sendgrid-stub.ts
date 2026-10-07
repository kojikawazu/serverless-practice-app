import type { Logger } from "../types/logger";
import type { MailSender, OutgoingMail } from "../types/mail";

/**
 * SendGrid の代わりに、送信内容を構造化ログへ出すスタブ。実在の宛先へは何も送らない。
 */
export class SendGridStub implements MailSender {
  /**
   * @param logger - 呼び出し元の handler のロガー
   */
  constructor(private readonly logger: Logger) {}

  /**
   * 送信内容を 1 行のログに出す。
   *
   * @param mail - 送信内容
   * @returns ログを出し終えたら解決する
   */
  send(mail: OutgoingMail): Promise<void> {
    this.logger.info("メールを送信しました（スタブ）", {
      stub: "sendgrid",
      executionName: mail.executionName,
      recipientId: mail.recipientId,
      to: mail.to,
      subject: mail.subject,
    });
    return Promise.resolve();
  }
}
