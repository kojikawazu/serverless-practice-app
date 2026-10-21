import { z } from "zod";

/**
 * CloudWatch アラームの状態変化イベント（EventBridge → Slack 通知 Lambda。docs/07「アラームの状態変化イベント」）。
 * Scheduler の DLQ に起動の失敗が届いたことを知らせるアラーム（#101）が、ALARM になったときに届く。
 *
 * 形は公式「Alarm events and EventBridge」の例から作り、`dev` で観測した実物（2026-10-21。#101）と、使う項目の位置・型が
 * 一致することを確かめた（docs/07「アラームの状態変化イベント」）。
 * 検証するのは通知に使う項目だけにし、未知のキーは拒否せず取り除く（状態変化イベントと同じ方針。#30）。
 */
export const alarmStateChangeEventSchema = z.object({
  source: z.literal("aws.cloudwatch"),
  "detail-type": z.literal("CloudWatch Alarm State Change"),
  detail: z.object({
    alarmName: z.string().min(1),
    state: z.object({
      /** 通知するのは ALARM への変化だけ。EventBridge rule のイベントパターンと揃える */
      value: z.literal("ALARM"),
      /** CloudWatch が書く、状態が変わった理由（閾値を越えたデータポイントなど）の文 */
      reason: z.string(),
    }),
  }),
});

/** CloudWatch アラームの状態変化イベントのうち、通知対象のもの */
export type AlarmStateChangeEvent = z.infer<typeof alarmStateChangeEventSchema>;
