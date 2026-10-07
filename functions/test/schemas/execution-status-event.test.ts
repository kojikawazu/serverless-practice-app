import { describe, expect, it } from "vitest";
import { executionStatusEventSchema } from "../../src/schemas/execution-status-event";

/** EventBridge が届ける FAILED のイベント（エンベロープの主な項目を含む） */
const FAILED_EVENT = {
  version: "0",
  id: "event-id",
  source: "aws.states",
  "detail-type": "Step Functions Execution Status Change",
  account: "000000000000",
  time: "2026-10-08T00:00:00Z",
  region: "ap-northeast-1",
  resources: [
    "arn:aws:states:ap-northeast-1:000000000000:execution:batch:run-1",
  ],
  detail: {
    executionArn:
      "arn:aws:states:ap-northeast-1:000000000000:execution:batch:run-1",
    stateMachineArn:
      "arn:aws:states:ap-northeast-1:000000000000:stateMachine:batch",
    name: "run-1",
    status: "FAILED",
    startDate: 1_791_417_600_000,
    stopDate: 1_791_417_605_000,
    input: '{"failAt":"dataSync"}',
    error: "InjectedFailureError",
    cause: "failAt=dataSync の指定により失敗を注入しました",
  },
};

describe("executionStatusEventSchema（状態変化イベント）", () => {
  describe("正常系", () => {
    it("FAILED のイベントから通知に使う項目を取り出し、エンベロープの他の項目は取り除く", () => {
      const parsed = executionStatusEventSchema.parse(FAILED_EVENT);

      expect(parsed).toEqual({
        source: "aws.states",
        "detail-type": "Step Functions Execution Status Change",
        detail: {
          executionArn: FAILED_EVENT.detail.executionArn,
          stateMachineArn: FAILED_EVENT.detail.stateMachineArn,
          name: "run-1",
          status: "FAILED",
          startDate: 1_791_417_600_000,
          stopDate: 1_791_417_605_000,
          error: "InjectedFailureError",
          cause: "failAt=dataSync の指定により失敗を注入しました",
        },
      });
    });
  });

  describe("準正常系", () => {
    it.each(["TIMED_OUT", "ABORTED"])(
      "%s で error と cause が null でも受理する",
      (status) => {
        const event = {
          ...FAILED_EVENT,
          detail: { ...FAILED_EVENT.detail, status, error: null, cause: null },
        };

        expect(executionStatusEventSchema.parse(event).detail).toMatchObject({
          status,
          error: null,
          cause: null,
        });
      },
    );

    it("error と cause の項目自体が無くても受理する", () => {
      const { error: _error, cause: _cause, ...detail } = FAILED_EVENT.detail;

      expect(
        executionStatusEventSchema.parse({ ...FAILED_EVENT, detail }).detail
          .error,
      ).toBeUndefined();
    });

    it.each(["SUCCEEDED", "RUNNING"])(
      "通知対象でない状態 %s を拒否する",
      (status) => {
        const event = {
          ...FAILED_EVENT,
          detail: { ...FAILED_EVENT.detail, status },
        };

        expect(executionStatusEventSchema.safeParse(event).success).toBe(false);
      },
    );

    it("Step Functions 以外のイベントを拒否する", () => {
      expect(
        executionStatusEventSchema.safeParse({
          ...FAILED_EVENT,
          source: "aws.s3",
        }).success,
      ).toBe(false);
    });

    it("detail-type が違うイベントを拒否する", () => {
      const event = {
        ...FAILED_EVENT,
        "detail-type": "Step Functions State Machine Status Change",
      };

      expect(executionStatusEventSchema.safeParse(event).success).toBe(false);
    });
  });

  describe("異常系", () => {
    it("detail が無いイベントを拒否する", () => {
      const { detail: _detail, ...envelope } = FAILED_EVENT;

      expect(executionStatusEventSchema.safeParse(envelope).success).toBe(
        false,
      );
    });

    it("startDate が文字列のイベントを拒否する", () => {
      const event = {
        ...FAILED_EVENT,
        detail: { ...FAILED_EVENT.detail, startDate: "2026-10-08" },
      };

      expect(executionStatusEventSchema.safeParse(event).success).toBe(false);
    });
  });
});
