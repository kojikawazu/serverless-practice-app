import { z } from "zod";

/**
 * SQS イベントソースから Consumer へ届くイベントのうち、処理に使う項目（docs/07「エンドポイント一覧」）。
 * 呼び出し元が AWS サービスでも形式を信頼しない（docs/06「入力バリデーション」）。
 * 本文（`body`）の中身は 1 件ずつ `mailMessageSchema` で検証するため、ここでは文字列であることだけを見る。
 */
export const sqsEventSchema = z.object({
  Records: z.array(
    z.object({
      /** 部分バッチ応答で失敗を返すときの識別子 */
      messageId: z.string().min(1),
      body: z.string(),
      attributes: z.object({
        /** FIFO キューのメッセージグループ ID。同じグループ内の順序を守るために使う */
        MessageGroupId: z.string().min(1).optional(),
      }),
    }),
  ),
});

/** Consumer へ届く SQS イベントのうち、処理に使う項目 */
export type SqsEvent = z.infer<typeof sqsEventSchema>;
