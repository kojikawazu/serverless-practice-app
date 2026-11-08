import { z } from "zod";
import { alarmStateChangeEventSchema } from "./alarm-state-change-event";
import { executionStatusEventSchema } from "./execution-status-event";

/**
 * Slack 通知 Lambda が受け付けるイベント（docs/03「Slack 通知 Lambda」）。`source` で種類を見分ける。
 * どちらにも当たらないイベントは通知対象外として扱う。
 */
export const notificationEventSchema = z.discriminatedUnion("source", [
  /** 実行が FAILED / TIMED_OUT / ABORTED で終わった（F-5） */
  executionStatusEventSchema,
  /** 状態変化イベントに乗らない失敗を知らせるアラームが ALARM になった（Scheduler の DLQ #101・実行が始まらない日 #109・メール送信キューの DLQ #135） */
  alarmStateChangeEventSchema,
]);
