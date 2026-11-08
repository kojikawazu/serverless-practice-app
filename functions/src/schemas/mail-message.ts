import { z } from "zod";
import { executionNameSchema } from "./execution";

/**
 * 配信対象の ID。MySQL スタブの固定データの形式（docs/05「配信対象」）。
 */
export const recipientIdSchema = z.string().regex(/^r-\d{3}$/);

/**
 * Consumer に失敗を注入する箇所（docs/05「メールメッセージ」）。実行入力の `failAt` から投入 Lambda が決める。
 */
export const simulateFailureSchema = z.enum([
  /** 失敗させない */
  "none",
  /** 送る前に失敗する。`failAt: "consumer"`。何度受け取っても失敗し、DLQ へ移る */
  "beforeSend",
  /** 送って送信済みを記録した後に失敗する。`failAt: "consumerAfterSend"`。再配信では送らずに成功する */
  "afterSend",
]);

/** Consumer に失敗を注入する箇所 */
export type SimulateFailure = z.infer<typeof simulateFailureSchema>;

/**
 * SQS FIFO に積むメールメッセージの本文（docs/05「メールメッセージ」）。
 * Consumer は SQS から受け取った本文をこのスキーマで検証してから送る。
 */
export const mailMessageSchema = z.strictObject({
  /** 投入したステートマシンの実行名 */
  executionName: executionNameSchema,
  recipientId: recipientIdSchema,
  /**
   * 宛先メールアドレス。`@example.com` に限る。
   * スタブ経由でも実在の宛先を扱わない（docs/06「データ保護」）ための最後の防壁
   */
  email: z.email().endsWith("@example.com"),
  /** 件名。デモでは固定文言 */
  subject: z.string().min(1),
  /** Consumer に失敗を注入する箇所。`failAt` が Consumer のどちらでもなければ `"none"` */
  simulateFailure: simulateFailureSchema,
});

/** SQS FIFO に積むメールメッセージの本文 */
export type MailMessage = z.infer<typeof mailMessageSchema>;
