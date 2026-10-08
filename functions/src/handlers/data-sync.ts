import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { InjectedFailureError } from "../errors/injected-failure-error";
import { loadHandlerContext } from "../lib/handler-context";
import { parseInput } from "../lib/parse";
import { dataSyncEnvSchema } from "../schemas/env";
import { taskInputSchema } from "../schemas/execution";
import type { TaskInput } from "../schemas/execution";
import { BigQueryStub } from "../stubs/bigquery-stub";
import { CuenoteFcStub } from "../stubs/cuenote-fc-stub";
import { MySqlStub } from "../stubs/mysql-stub";
import type { ExportWriter } from "../types/export";
import type { Logger } from "../types/logger";
import type { Recipient, RecipientRepository } from "../types/recipient";

/**
 * データ連携 Lambda の依存。Lambda の入口では本物を組み立て、テストでは S3 以外も本物を渡す。
 */
export type DataSyncDeps = {
  s3: S3Client;
  /** 連携ファイルの出力先バケット名 */
  bucketName: string;
  recipients: RecipientRepository;
  /** BigQuery への書き出し先 */
  warehouse: ExportWriter;
  /** Cuenote FC への書き出し先 */
  marketingList: ExportWriter;
  logger: Logger;
  /** 現在時刻。連携ファイルのキーの日付と `exportedAt` に使う。テストでは固定する */
  now: () => Date;
};

/**
 * データ連携 Lambda の出力（docs/07「データ連携 Lambda の出力」）。
 */
export type DataSyncResult = {
  /** 書き出した配信対象の件数 */
  exported: number;
  /** 連携ファイルの S3 キー */
  s3Key: string;
};

/**
 * S3 に書く連携ファイルの中身（docs/05「連携ファイル」）。
 */
type ExportFile = {
  executionName: string;
  /** 書き出した時刻（ISO 8601、UTC） */
  exportedAt: string;
  recipients: readonly Recipient[];
};

/**
 * 配信対象を S3・BigQuery・Cuenote FC へ順に書き出す（docs/03「データ連携 Lambda」）。
 *
 * - 書き出し順は S3 → BigQuery → Cuenote FC に固定する。途中で失敗すると前段の書き込みは残る
 *   （元資料のリスク 4。補償処理は持たない）
 * - `failAt` が `dataSync` なら、S3 へ書いた後・BigQuery へ書く前に失敗する
 * - 失敗はエラーログを 1 行出してから投げ直す。実行名が分かった後の失敗には `executionName` を付ける
 *
 * @param input - Step Functions から受け取るタスク入力（未検証）
 * @param deps - 依存
 * @returns 書き出した件数と S3 キー
 * @throws {ValidationError} タスク入力がスキーマに合わない場合
 * @throws {InjectedFailureError} `failAt` が `dataSync` の場合（S3 には書いた後）
 */
export async function dataSync(
  input: unknown,
  deps: DataSyncDeps,
): Promise<DataSyncResult> {
  let logger = deps.logger;
  try {
    const task = parseInput(taskInputSchema, input, "タスク入力");
    logger = logger.child({ executionName: task.executionName });
    return await exportRecipients(task, deps, logger);
  } catch (error) {
    logger.error("データ連携に失敗しました", error);
    throw error;
  }
}

/**
 * 検証済みのタスク入力から、配信対象を各書き出し先へ順に書く。
 *
 * @param task - 検証済みのタスク入力
 * @param deps - 依存
 * @param logger - 実行名を付けたロガー
 * @returns 書き出した件数と S3 キー
 * @throws {InjectedFailureError} `failAt` が `dataSync` の場合
 */
async function exportRecipients(
  task: TaskInput,
  deps: DataSyncDeps,
  logger: Logger,
): Promise<DataSyncResult> {
  const { executionName, failAt } = task;
  const recipients = await deps.recipients.findAll();

  const exportedAt = deps.now().toISOString();
  // 日付は UTC。同じ実行を再実行すると同じキーに上書きされる（docs/05「連携ファイル」）
  const s3Key = `exports/${exportedAt.slice(0, 10)}/${executionName}.json`;
  const file: ExportFile = { executionName, exportedAt, recipients };
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.bucketName,
      Key: s3Key,
      Body: JSON.stringify(file),
      ContentType: "application/json",
    }),
  );

  if (failAt === "dataSync") {
    throw new InjectedFailureError(failAt);
  }

  await deps.warehouse.write(executionName, recipients);
  await deps.marketingList.write(executionName, recipients);

  logger.info("データ連携を完了しました", {
    exported: recipients.length,
    s3Key,
  });
  return { exported: recipients.length, s3Key };
}

/** S3 クライアント。実行環境の再利用（ウォームスタート）時に接続を使い回すため、モジュールで 1 つ持つ */
const s3 = new S3Client({});

/**
 * Lambda の入口。環境変数から依存を組み立てて `dataSync` を呼ぶ。
 *
 * @param event - Step Functions から受け取るタスク入力
 * @returns 書き出した件数と S3 キー
 * @throws {ValidationError} 環境変数またはタスク入力が不正な場合
 * @throws {InjectedFailureError} `failAt` が `dataSync` の場合
 */
export async function handler(event: unknown): Promise<DataSyncResult> {
  const { env, logger } = loadHandlerContext("data-sync", dataSyncEnvSchema);
  return await dataSync(event, {
    s3,
    bucketName: env.BUCKET_NAME,
    recipients: new MySqlStub(),
    warehouse: new BigQueryStub(logger),
    marketingList: new CuenoteFcStub(logger),
    logger,
    now: () => new Date(),
  });
}
