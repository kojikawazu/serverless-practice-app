import { describe, expect, it } from "vitest";
import { alarmStateChangeEventSchema } from "../../src/schemas/alarm-state-change-event";

/**
 * EventBridge が届ける ALARM への変化のイベント。公式「Alarm events and EventBridge」の Single Metric Alarm の例を、
 * このデモのアラームに置き換えて作った（実物は未観測。docs/09「`dev` での検証結果」で突き合わせる）
 */
const ALARM_EVENT = {
  version: "0",
  id: "event-id",
  "detail-type": "CloudWatch Alarm State Change",
  source: "aws.cloudwatch",
  account: "000000000000",
  time: "2026-10-20T00:05:00Z",
  region: "ap-northeast-1",
  resources: [
    "arn:aws:cloudwatch:ap-northeast-1:000000000000:alarm:serverless-practice-app-dev-scheduler-dlq",
  ],
  detail: {
    alarmName: "serverless-practice-app-dev-scheduler-dlq",
    configuration: { metrics: [] },
    previousState: {
      reason: "Unchecked: Initial alarm creation",
      timestamp: "2026-10-20T00:00:00.000+0000",
      value: "INSUFFICIENT_DATA",
    },
    state: {
      reason:
        "Threshold Crossed: 1 out of the last 1 datapoints [1.0 (20/10/26 00:00:00)] was greater than or equal to the threshold (1.0) (minimum 1 datapoint for OK -> ALARM transition).",
      reasonData: '{"version":"1.0"}',
      timestamp: "2026-10-20T00:05:00.000+0000",
      value: "ALARM",
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
