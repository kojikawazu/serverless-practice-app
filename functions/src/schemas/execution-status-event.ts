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

/**
 * Step Functions の状態変化イベント（EventBridge → Slack 通知 Lambda）。
 * EventBridge のエンベロープは他にも多くのフィールドを持つため、未知のキーは拒否せず取り除く。
 */
export const executionStatusEventSchema = z.object({
  source: z.literal("aws.states"),
  "detail-type": z.literal("Step Functions Execution Status Change"),
  detail: z.object({
    executionArn: z.string().min(1),
    stateMachineArn: z.string().min(1),
    /** 実行名 */
    name: z.string().min(1),
    status: notifiedStatusSchema,
    /** 開始時刻（エポックミリ秒） */
    startDate: z.number(),
    /** 終了時刻（エポックミリ秒）。終了前のイベントでは `null` */
    stopDate: z.number().nullish(),
    /** エラー名。`TIMED_OUT` / `ABORTED` では `null` になりうる */
    error: z.string().nullish(),
    /** エラーの原因。`TIMED_OUT` / `ABORTED` では `null` になりうる */
    cause: z.string().nullish(),
  }),
});

/** Step Functions の状態変化イベントのうち、通知対象のもの */
export type ExecutionStatusEvent = z.infer<typeof executionStatusEventSchema>;
