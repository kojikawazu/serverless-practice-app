import { z } from "zod";

/**
 * 失敗を注入する箇所。値と結果の対応は docs/02「F-6: 失敗の注入」。
 */
export const failAtSchema = z.enum([
  /** 投入 Lambda がキューへ積む前に失敗する。実行は FAILED で通知が出る */
  "enqueue",
  /** データ連携 Lambda が S3 へ書いた後に失敗する。実行は FAILED で通知が出る */
  "dataSync",
  /** Consumer が全メッセージで失敗する。実行は SUCCEEDED のまま、メッセージは DLQ へ移る */
  "consumer",
]);

/** 失敗を注入する箇所 */
export type FailAt = z.infer<typeof failAtSchema>;

/**
 * 検証用の待ち時間（秒）の上限。データ連携 Lambda のタイムアウト（1,800 秒）に処理の余裕を残して収め、
 * 待つ分の EC2 料金を抑える（docs/09「LMI（Lambda Managed Instances）」）
 */
const HOLD_SECONDS_MAX = 1200;

/**
 * 検証用の待ち時間（秒）。データ連携 Lambda が結果を返す前にこの秒数だけ待つ。
 * LMI で 15 分を超える実行を再現するための注入で、定時起動では使わない（docs/09「LMI（Lambda Managed Instances）」）
 */
const holdSecondsSchema = z.int().min(0).max(HOLD_SECONDS_MAX);

/**
 * Step Functions の実行入力（`StartExecution` の `input`）。
 * 未知のキーは拒否する。`failat` のような綴り違いを「failAt 省略」として通すと、
 * 失敗を注入したつもりで正常に実行されてしまうため。
 */
export const executionInputSchema = z.strictObject({
  /** 失敗を注入する箇所。省略時は失敗させない */
  failAt: failAtSchema.optional(),
  /** 検証用の待ち時間（秒）。省略時は待たない */
  holdSeconds: holdSecondsSchema.optional(),
});

/** Step Functions の実行入力 */
export type ExecutionInput = z.infer<typeof executionInputSchema>;

/**
 * Step Functions の実行名。S3 のキーと SQS の重複排除 ID に埋め込むため、
 * キーの区切り `/` などを含ませないよう文字種を制限する（docs/06「入力バリデーション」）。
 * 80 文字は Step Functions の実行名の上限。
 */
export const executionNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

/**
 * 投入 Lambda・データ連携 Lambda が Step Functions から受け取るタスク入力（docs/07「タスク入力」）。
 */
export const taskInputSchema = z.strictObject({
  /** 呼び出し元の実行名（`$$.Execution.Name`） */
  executionName: executionNameSchema,
  /** 実行入力から引き継いだ失敗の注入箇所。省略時は失敗させない */
  failAt: failAtSchema.optional(),
  /** 実行入力から引き継いだ検証用の待ち時間（秒）。データ連携 Lambda だけが使う。省略時は待たない */
  holdSeconds: holdSecondsSchema.optional(),
});

/** 投入 Lambda・データ連携 Lambda のタスク入力 */
export type TaskInput = z.infer<typeof taskInputSchema>;

/**
 * Step Functions のタスクトークン（`$states.context.Task.Token`）。結果を `SendTask*` で返す宛先。
 * 長さは `SendTaskSuccess` などの `taskToken` の制約（1〜2,048 文字）に合わせる
 */
export const taskTokenSchema = z.string().min(1).max(2048);

/**
 * データ連携 Lambda のタスク入力。`.waitForTaskToken` で非同期に呼ばれるため、
 * 共通のタスク入力に結果の返し先のタスクトークンが足される（docs/07「タスク入力」）。
 */
export const dataSyncTaskInputSchema = taskInputSchema.extend({
  /** 結果を返すタスクトークン */
  taskToken: taskTokenSchema,
});

/** データ連携 Lambda のタスク入力 */
export type DataSyncTaskInput = z.infer<typeof dataSyncTaskInputSchema>;
