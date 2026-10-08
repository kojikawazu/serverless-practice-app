import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SendMessageBatchRequestEntry } from "@aws-sdk/client-sqs";
import { EnqueuePartialFailureError } from "../errors/enqueue-partial-failure-error";
import { InjectedFailureError } from "../errors/injected-failure-error";
import { createLogger } from "../lib/logger";
import { parseInput } from "../lib/parse";
import { enqueueEnvSchema } from "../schemas/env";
import { taskInputSchema } from "../schemas/execution";
import type { TaskInput } from "../schemas/execution";
import type { MailMessage } from "../schemas/mail-message";
import { MySqlStub } from "../stubs/mysql-stub";
import type { Logger } from "../types/logger";
import type { RecipientRepository } from "../types/recipient";

/** `SendMessageBatch` 1 回に載せられる件数の上限（SQS の仕様） */
const SEND_BATCH_LIMIT = 10;

/** メールの件名。デモでは固定文言（docs/05「メールメッセージ」） */
const MAIL_SUBJECT = "serverless-practice-app デモ配信";

/**
 * 投入 Lambda の依存。Lambda の入口では本物を組み立て、テストでは SQS 以外も本物を渡す。
 */
export type EnqueueDeps = {
  sqs: SQSClient;
  /** メール送信キューの URL */
  queueUrl: string;
  recipients: RecipientRepository;
  logger: Logger;
};

/**
 * 投入 Lambda の出力（docs/07「投入 Lambda の出力」）。
 */
export type EnqueueResult = {
  /** キューへ積んだメッセージ数。配信対象の件数と一致する */
  enqueued: number;
};

/**
 * 配列を指定の件数ごとに分ける。
 *
 * @param items - 分ける配列
 * @param size - 1 つあたりの件数（1 以上）
 * @returns 分けた配列の配列。`items` が空なら空配列
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * 配信対象ごとにメールメッセージを作り、SQS FIFO へ積む（docs/03「投入 Lambda」）。
 *
 * - 重複排除 ID は `<実行名>:<配信対象 ID>` で決定的に作る。Step Functions の Retry で同じ実行が
 *   再投入されても、5 分以内なら FIFO が重複を除く
 * - 一部のメッセージが送れなくても残りのバッチは送り切り、最後にまとめて失敗させる
 * - 失敗はエラーログを 1 行出してから投げ直す。実行名が分かった後の失敗には `executionName` を付ける
 *
 * @param input - Step Functions から受け取るタスク入力（未検証）
 * @param deps - 依存
 * @returns 積んだ件数
 * @throws {ValidationError} タスク入力がスキーマに合わない場合
 * @throws {InjectedFailureError} `failAt` が `enqueue` の場合（キューへは何も積まない）
 * @throws {EnqueuePartialFailureError} `SendMessageBatch` の一部が失敗した場合
 */
export async function enqueue(
  input: unknown,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  let logger = deps.logger;
  try {
    const task = parseInput(taskInputSchema, input, "タスク入力");
    logger = logger.child({ executionName: task.executionName });
    return await sendMessages(task, deps, logger);
  } catch (error) {
    logger.error("投入に失敗しました", error);
    throw error;
  }
}

/**
 * 検証済みのタスク入力から、配信対象ごとのメッセージを作って送る。
 *
 * @param task - 検証済みのタスク入力
 * @param deps - 依存
 * @param logger - 実行名を付けたロガー
 * @returns 積んだ件数
 * @throws {InjectedFailureError} `failAt` が `enqueue` の場合
 * @throws {EnqueuePartialFailureError} `SendMessageBatch` の一部が失敗した場合
 */
async function sendMessages(
  task: TaskInput,
  deps: EnqueueDeps,
  logger: Logger,
): Promise<EnqueueResult> {
  const { executionName, failAt } = task;
  if (failAt === "enqueue") {
    throw new InjectedFailureError(failAt);
  }

  const recipients = await deps.recipients.findAll();
  const entries = recipients.map((recipient): SendMessageBatchRequestEntry => {
    const message: MailMessage = {
      executionName,
      recipientId: recipient.recipientId,
      email: recipient.email,
      subject: MAIL_SUBJECT,
      simulateFailure: failAt === "consumer",
    };
    return {
      // バッチ内の識別子。失敗時にどの配信対象が送れなかったかを示せるよう配信対象 ID を使う
      Id: recipient.recipientId,
      MessageBody: JSON.stringify(message),
      // 順序が要るのは同じ宛先の中だけのため、宛先ごとにグループを分ける（docs/05）
      MessageGroupId: recipient.recipientId,
      MessageDeduplicationId: `${executionName}:${recipient.recipientId}`,
    };
  });

  const failedIds: string[] = [];
  for (const batch of chunk(entries, SEND_BATCH_LIMIT)) {
    const result = await deps.sqs.send(
      new SendMessageBatchCommand({ QueueUrl: deps.queueUrl, Entries: batch }),
    );
    failedIds.push(
      ...(result.Failed ?? []).map((failure) => failure.Id ?? "(ID なし)"),
    );
  }

  if (failedIds.length > 0) {
    throw new EnqueuePartialFailureError(failedIds);
  }

  logger.info("メールメッセージを投入しました", { enqueued: entries.length });
  return { enqueued: entries.length };
}

/** SQS クライアント。実行環境の再利用（ウォームスタート）時に接続を使い回すため、モジュールで 1 つ持つ */
const sqs = new SQSClient({});

/**
 * Lambda の入口。環境変数から依存を組み立てて `enqueue` を呼ぶ。
 *
 * @param event - Step Functions から受け取るタスク入力
 * @returns 積んだ件数
 * @throws {ValidationError} 環境変数またはタスク入力が不正な場合
 * @throws {InjectedFailureError} `failAt` が `enqueue` の場合
 * @throws {EnqueuePartialFailureError} `SendMessageBatch` の一部が失敗した場合
 */
export async function handler(event: unknown): Promise<EnqueueResult> {
  const env = parseInput(enqueueEnvSchema, process.env, "環境変数");
  return await enqueue(event, {
    sqs,
    queueUrl: env.QUEUE_URL,
    recipients: new MySqlStub(),
    logger: createLogger({ function: "enqueue", stage: env.STAGE }),
  });
}
