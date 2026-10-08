import type { SQSBatchResponse } from "aws-lambda";
import { InjectedFailureError } from "../errors/injected-failure-error";
import { createLogger } from "../lib/logger";
import { parseInput } from "../lib/parse";
import { baseEnvSchema } from "../schemas/env";
import { mailMessageSchema } from "../schemas/mail-message";
import { sqsEventSchema } from "../schemas/sqs-event";
import type { SqsEvent } from "../schemas/sqs-event";
import { SendGridStub } from "../stubs/sendgrid-stub";
import type { Logger } from "../types/logger";
import type { MailSender } from "../types/mail";

/**
 * Consumer Lambda の依存。Lambda の入口では本物のスタブを組み立てる。
 */
export type ConsumerDeps = {
  mailSender: MailSender;
  logger: Logger;
};

/** SQS イベントの 1 件分 */
type SqsRecord = SqsEvent["Records"][number];

/**
 * メッセージ 1 件を検証して送る。
 *
 * @param record - SQS イベントの 1 件
 * @param deps - 依存
 * @throws {SyntaxError} 本文が JSON として読めない場合
 * @throws {ValidationError} 本文がメールメッセージのスキーマに合わない場合
 * @throws {InjectedFailureError} `simulateFailure` が `true` の場合
 */
async function processRecord(
  record: SqsRecord,
  deps: ConsumerDeps,
): Promise<void> {
  const message = parseInput(
    mailMessageSchema,
    JSON.parse(record.body),
    "メッセージ本文",
  );
  if (message.simulateFailure) {
    throw new InjectedFailureError("consumer");
  }
  await deps.mailSender.send({
    executionName: message.executionName,
    recipientId: message.recipientId,
    to: message.email,
    subject: message.subject,
  });
}

/**
 * SQS FIFO から受け取ったメッセージを 1 件ずつ送り、失敗したものだけを返す（docs/03「Consumer Lambda」）。
 *
 * 失敗したメッセージと同じグループの後続メッセージは、送らずに失敗として返す。
 * 送ってしまうと、再配信された前のメッセージが後から届き、グループ内の順序が逆転するため。
 * 別のグループのメッセージは影響を受けず、そのまま送る。
 *
 * @param event - SQS イベント（未検証）
 * @param deps - 依存
 * @returns 部分バッチ応答。全件成功なら `batchItemFailures` は空配列
 * @throws {ValidationError} イベントの形式が不正な場合（バッチ全体が再配信される）
 */
export async function consume(
  event: unknown,
  deps: ConsumerDeps,
): Promise<SQSBatchResponse> {
  const { Records } = parseInput(sqsEventSchema, event, "SQS イベント");
  const failedGroups = new Set<string>();
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of Records) {
    const groupId = record.attributes.MessageGroupId;
    if (groupId !== undefined && failedGroups.has(groupId)) {
      deps.logger.info("同じグループの先行メッセージが失敗したため送りません", {
        messageId: record.messageId,
        messageGroupId: groupId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    try {
      await processRecord(record, deps);
    } catch (error) {
      deps.logger.error("メッセージの処理に失敗しました", error, {
        messageId: record.messageId,
        messageGroupId: groupId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      if (groupId !== undefined) {
        failedGroups.add(groupId);
      }
    }
  }

  return { batchItemFailures };
}

/**
 * Lambda の入口。環境変数から依存を組み立てて `consume` を呼ぶ。
 *
 * @param event - SQS イベント
 * @returns 部分バッチ応答
 * @throws {ValidationError} 環境変数またはイベントの形式が不正な場合
 */
export async function handler(event: unknown): Promise<SQSBatchResponse> {
  const env = parseInput(baseEnvSchema, process.env, "環境変数");
  const logger = createLogger({ function: "consumer", stage: env.STAGE });
  return await consume(event, { mailSender: new SendGridStub(logger), logger });
}
