import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  SFNClient,
  SendTaskFailureCommand,
  SendTaskHeartbeatCommand,
  SendTaskSuccessCommand,
} from "@aws-sdk/client-sfn";
import { z } from "zod";
import { InjectedFailureError } from "../errors/injected-failure-error";
import { loadHandlerContext } from "../lib/handler-context";
import { parseInput } from "../lib/parse";
import { dataSyncEnvSchema } from "../schemas/env";
import { dataSyncTaskInputSchema, taskTokenSchema } from "../schemas/execution";
import type { DataSyncTaskInput } from "../schemas/execution";
import { BigQueryStub } from "../stubs/bigquery-stub";
import { CuenoteFcStub } from "../stubs/cuenote-fc-stub";
import { MySqlStub } from "../stubs/mysql-stub";
import type { ExportWriter } from "../types/export";
import type { Logger } from "../types/logger";
import type { Recipient, RecipientRepository } from "../types/recipient";

/**
 * 待っている間にハートビートを送る間隔（秒）。ステートマシンのハートビートのタイムアウト（300 秒）より十分短くする
 * （docs/09「LMI（Lambda Managed Instances）」）
 */
const HEARTBEAT_INTERVAL_SECONDS = 60;

/**
 * `SendTaskFailure` の `cause` に入れるエラーメッセージの最大文字数。`cause` の上限（32,768 文字）に、
 * JSON の項目名を足しても収まるよう余裕を取る。超えた分は切り捨てる
 */
const MAX_CAUSE_MESSAGE_LENGTH = 4096;

/** タスクトークンだけを取り出すスキーマ。ほかの項目が不正でも、結果の返し先は先に分かるようにする */
const taskTokenHolderSchema = z.object({ taskToken: taskTokenSchema });

/**
 * データ連携 Lambda の依存。Lambda の入口では本物を組み立て、テストでは S3・Step Functions 以外も本物を渡す。
 */
export type DataSyncDeps = {
  s3: S3Client;
  /** 結果（成功・失敗・ハートビート）を返す先 */
  sfn: SFNClient;
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
  /** 指定したミリ秒だけ待つ。`holdSeconds` の待ちに使う。テストでは待たずに記録する */
  sleep: (ms: number) => Promise<void>;
};

/**
 * データ連携 Lambda の出力。`SendTaskSuccess` の `output` として Step Functions へ返す（docs/07「データ連携 Lambda の出力」）。
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
 * 配信対象を S3・BigQuery・Cuenote FC へ順に書き出し、結果を Step Functions へ返す（docs/03「データ連携 Lambda」）。
 *
 * `.waitForTaskToken` で非同期に呼ばれるため、戻り値・例外は Step Functions に届かない。
 * 結果は必ずタスクトークンで返す（成功は `SendTaskSuccess`、失敗は `SendTaskFailure`）。
 * **例外は投げない。** 非同期の呼び出しで投げた例外を受け取るのは Lambda の再試行だけで、
 * 同じタスクトークンで処理を二重に走らせる（S3・スタブへの書き込みが重なる）ため（docs/09「LMI（Lambda Managed Instances）」）。
 *
 * - 書き出し順は S3 → BigQuery → Cuenote FC に固定する。途中で失敗すると前段の書き込みは残る
 *   （元資料のリスク 4。補償処理は持たない）
 * - `failAt` が `dataSync` なら、S3 へ書いた後・BigQuery へ書く前に失敗する
 * - `holdSeconds` があれば、書き出しの後にその秒数だけ待つ。待つ間はハートビートを送る
 * - 失敗はエラーログを 1 行出し、`SendTaskFailure` で返す。実行名が分かった後の失敗には `executionName` を付ける
 * - タスクトークンが無い・不正なら結果を返せない。エラーログを出して終え、ステートマシン側のタイムアウトに任せる
 *
 * @param input - Step Functions から受け取るタスク入力（未検証）
 * @param deps - 依存
 * @returns 結果を返し終えたら（返せなかった場合はエラーログを出したら）解決する。拒否はしない
 */
export async function dataSync(
  input: unknown,
  deps: DataSyncDeps,
): Promise<void> {
  let logger = deps.logger;
  let taskToken: string;
  try {
    // 結果の返し先。ほかの項目の検証に失敗しても、その失敗を返せるよう先に取り出す
    taskToken = parseInput(
      taskTokenHolderSchema,
      input,
      "タスク入力",
    ).taskToken;
  } catch (error) {
    logger.error(
      "タスクトークンが読めないため、結果を Step Functions へ返せません",
      error,
    );
    return;
  }

  try {
    const task = parseInput(dataSyncTaskInputSchema, input, "タスク入力");
    logger = logger.child({ executionName: task.executionName });
    const result = await exportRecipients(task, deps, logger);
    await hold(task.holdSeconds ?? 0, taskToken, deps, logger);
    await deps.sfn.send(
      new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(result) }),
    );
  } catch (error) {
    logger.error("データ連携に失敗しました", error);
    await reportFailure(taskToken, error, deps, logger);
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
  task: DataSyncTaskInput,
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

/**
 * 検証用に指定した秒数だけ待つ。ハートビートのタイムアウトで打ち切られないよう、
 * {@link HEARTBEAT_INTERVAL_SECONDS} ごとにハートビートを送ってから待つ。
 *
 * @param seconds - 待つ秒数。0 なら何もしない
 * @param taskToken - ハートビートを送るタスクトークン
 * @param deps - 依存
 * @param logger - 実行名を付けたロガー
 * @returns 待ち終えたら解決する
 */
async function hold(
  seconds: number,
  taskToken: string,
  deps: DataSyncDeps,
  logger: Logger,
): Promise<void> {
  if (seconds === 0) {
    return;
  }
  logger.info("検証用に待ちます", { holdSeconds: seconds });
  let remaining = seconds;
  while (remaining > 0) {
    await deps.sfn.send(new SendTaskHeartbeatCommand({ taskToken }));
    const chunk = Math.min(HEARTBEAT_INTERVAL_SECONDS, remaining);
    await deps.sleep(chunk * 1000);
    remaining -= chunk;
  }
}

/**
 * 失敗を Step Functions へ返す。エラー名は `Retry` の判定に使われるため、Lambda が投げたときと同じ名前にする
 * （docs/07「エラー」）。返すこと自体に失敗したら、エラーログを出すだけにして元の失敗を優先する。
 *
 * @param taskToken - 失敗を返すタスクトークン
 * @param error - 起きた失敗
 * @param deps - 依存
 * @param logger - ロガー
 * @returns 返し終えたら（返せなかった場合はログを出したら）解決する
 */
async function reportFailure(
  taskToken: string,
  error: unknown,
  deps: DataSyncDeps,
  logger: Logger,
): Promise<void> {
  const errorType = error instanceof Error ? error.name : "Error";
  const errorMessage = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, MAX_CAUSE_MESSAGE_LENGTH);
  try {
    await deps.sfn.send(
      new SendTaskFailureCommand({
        taskToken,
        error: errorType,
        // Lambda が投げたときの cause と同じ形にそろえる（scripts/batch.sh が errorMessage を読む）
        cause: JSON.stringify({ errorType, errorMessage }),
      }),
    );
  } catch (sendError) {
    logger.error("失敗を Step Functions へ返せませんでした", sendError);
  }
}

/** S3 クライアント。実行環境の再利用（ウォームスタート）時に接続を使い回すため、モジュールで 1 つ持つ */
const s3 = new S3Client({});

/**
 * Step Functions クライアント。S3 と同じくモジュールで 1 つ持つ。
 * 状態を持たないため、LMI で 1 つの実行環境が複数の呼び出しを並行に処理しても共有してよい
 */
const sfn = new SFNClient({});

/**
 * Lambda の入口。環境変数から依存を組み立てて `dataSync` を呼ぶ。
 * 環境変数の誤りだけは `dataSync` の前に投げる（ロガーを組み立てられないため）。
 * そのとき結果は返せず、ステートマシン側のハートビートのタイムアウトで失敗になる
 *
 * @param event - Step Functions から受け取るタスク入力
 * @returns 結果を Step Functions へ返し終えたら解決する
 * @throws {ValidationError} 環境変数が不正な場合
 */
export async function handler(event: unknown): Promise<void> {
  const { env, logger } = loadHandlerContext("data-sync", dataSyncEnvSchema);
  await dataSync(event, {
    s3,
    sfn,
    bucketName: env.BUCKET_NAME,
    recipients: new MySqlStub(),
    warehouse: new BigQueryStub(logger),
    marketingList: new CuenoteFcStub(logger),
    logger,
    now: () => new Date(),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  });
}
