import { describe, expect, it } from "vitest";
import { alarmStateChangeEventSchema } from "../../src/schemas/alarm-state-change-event";

/**
 * EventBridge が届ける ALARM への変化のイベント。`dev` で観測した実物（2026-10-21。#101）を写し、
 * アカウント ID だけを伏せた（docs/09「`dev` での検証結果」・docs/07「アラームの状態変化イベント」）
 */
const ALARM_EVENT = {
  version: "0",
  id: "d0e0a508-8f80-75cf-cd7f-0348a8142bf7",
  "detail-type": "CloudWatch Alarm State Change",
  source: "aws.cloudwatch",
  account: "000000000000",
  time: "2026-10-21T12:37:58Z",
  region: "ap-northeast-1",
  resources: [
    "arn:aws:cloudwatch:ap-northeast-1:000000000000:alarm:serverless-practice-app-dev-scheduler-dlq",
  ],
  detail: {
    alarmName: "serverless-practice-app-dev-scheduler-dlq",
    state: {
      value: "ALARM",
      reason:
        "Threshold Crossed: 1 datapoint [1.0 (21/10/26 12:30:00)] was greater than or equal to the threshold (1.0).",
      reasonData:
        '{"version":"1.0","queryDate":"2026-10-21T12:37:58.556+0000","startDate":"2026-10-21T12:30:00.000+0000","statistic":"Sum","period":300,"recentDatapoints":[1.0],"threshold":1.0,"evaluatedDatapoints":[{"timestamp":"2026-10-21T12:30:00.000+0000","sampleCount":6.0,"value":1.0}]}',
      timestamp: "2026-10-21T12:37:58.559+0000",
    },
    previousState: {
      value: "OK",
      reason:
        "Threshold Crossed: no datapoints were received for 1 period and 1 missing datapoint was treated as [NonBreaching].",
      reasonData:
        '{"version":"1.0","queryDate":"2026-10-21T12:26:58.556+0000","statistic":"Sum","period":300,"recentDatapoints":[],"threshold":1.0,"evaluatedDatapoints":[{"timestamp":"2026-10-21T12:19:00.000+0000"}]}',
      timestamp: "2026-10-21T12:26:58.557+0000",
    },
    configuration: {
      metrics: [
        {
          id: "44d0af36-23c4-da3d-0597-611c9773e1de",
          metricStat: {
            metric: {
              namespace: "AWS/SQS",
              name: "NumberOfMessagesSent",
              dimensions: {
                QueueName: "serverless-practice-app-dev-scheduler-dlq",
              },
            },
            period: 300,
            stat: "Sum",
          },
          returnData: true,
        },
      ],
      description:
        "Scheduler がステートマシンを起動できず、呼び出しを DLQ へ送った（docs/04「リトライ」）",
    },
  },
};

describe("alarmStateChangeEventSchema（アラームの状態変化イベント）", () => {
  describe("正常系", () => {
    it("ALARM への変化から、通知に使う項目（アラーム名・理由）を取り出し、それ以外の項目は取り除く", () => {
      expect(alarmStateChangeEventSchema.parse(ALARM_EVENT)).toEqual({
        source: "aws.cloudwatch",
        "detail-type": "CloudWatch Alarm State Change",
        detail: {
          alarmName: "serverless-practice-app-dev-scheduler-dlq",
          state: { value: "ALARM", reason: ALARM_EVENT.detail.state.reason },
        },
      });
    });
  });

  describe("準正常系", () => {
    it.each(["OK", "INSUFFICIENT_DATA"])(
      "%s への変化は受理しない（通知するのは ALARM だけ）",
      (value) => {
        const event = {
          ...ALARM_EVENT,
          detail: {
            ...ALARM_EVENT.detail,
            state: { ...ALARM_EVENT.detail.state, value },
          },
        };

        expect(alarmStateChangeEventSchema.safeParse(event).success).toBe(
          false,
        );
      },
    );

    it("アラームの設定の変化（CloudWatch Alarm Configuration Change）は受理しない", () => {
      const event = {
        ...ALARM_EVENT,
        "detail-type": "CloudWatch Alarm Configuration Change",
      };

      expect(alarmStateChangeEventSchema.safeParse(event).success).toBe(false);
    });
  });

  describe("異常系", () => {
    it.each([
      ["アラーム名が空", { alarmName: "" }],
      ["理由が無い", { state: { value: "ALARM" } }],
    ])("%s のイベントは受理しない", (_label, override) => {
      const event = {
        ...ALARM_EVENT,
        detail: { ...ALARM_EVENT.detail, ...override },
      };

      expect(alarmStateChangeEventSchema.safeParse(event).success).toBe(false);
    });
  });
});
