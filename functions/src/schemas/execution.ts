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
 * Step Functions の実行入力（`StartExecution` の `input`）。
 * 未知のキーは拒否する。`failat` のような綴り違いを「failAt 省略」として通すと、
 * 失敗を注入したつもりで正常に実行されてしまうため。
 */
export const executionInputSchema = z.strictObject({
  /** 失敗を注入する箇所。省略時は失敗させない */
  failAt: failAtSchema.optional(),
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
});

/** 投入 Lambda・データ連携 Lambda のタスク入力 */
export type TaskInput = z.infer<typeof taskInputSchema>;
