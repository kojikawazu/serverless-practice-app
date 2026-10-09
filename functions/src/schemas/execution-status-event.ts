import { z } from "zod";

/**
 * Slack 通知の対象にする実行状態。EventBridge rule のイベントパターンと揃える（docs/07「状態変化イベント」）。
 */
export const notifiedStatusSchema = z.enum([
  /** タスクの失敗が Retry で解消されずに終わった */
  "FAILED",
  /** ステートマシンのタイムアウト（5 分）を超えた */
  "TIMED_OUT",
  /** 手動で停止された */
  "ABORTED",
]);

/** Slack 通知の対象にする実行状態 */
export type NotifiedStatus = z.infer<typeof notifiedStatusSchema>;

/**
 * Step Functions の状態変化イベント（EventBridge → Slack 通知 Lambda）。
 * EventBridge のエンベロープは他にも多くのフィールドを持つため、未知のキーは拒否せず取り除く。
 *
 * 検証するのは通知に使う項目だけにする。使わない項目（`startDate` / `stopDate` 等）は
 * 実行環境で形が違い（AWS はエポックミリ秒、LocalStack は ISO 8601 文字列）、
 * それを検証すると形の違いだけで失敗通知を捨てることになるため（#30）。
 */
export const executionStatusEventSchema = z.object({
  source: z.literal("aws.states"),
  "detail-type": z.literal("Step Functions Execution Status Change"),
  detail: z.object({
    executionArn: z.string().min(1),
    /** 実行名 */
    name: z.string().min(1),
    status: notifiedStatusSchema,
    /** エラー名。`TIMED_OUT` / `ABORTED` では `null` になりうる */
    error: z.string().nullish(),
    /** エラーの原因。`TIMED_OUT` / `ABORTED` では `null` になりうる */
    cause: z.string().nullish(),
  }),
});

/** Step Functions の状態変化イベントのうち、通知対象のもの */
export type ExecutionStatusEvent = z.infer<typeof executionStatusEventSchema>;
