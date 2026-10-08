import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { BatchStack } from "../lib/batch-stack";
import { parseStage } from "../lib/stage";
import type { Stage } from "../lib/stage";

/** 合成済みテンプレートの JSON（テストで中身を直接読むため、必要な形だけを書く） */
type TemplateJson = {
  Parameters: Record<string, { Default?: string }>;
  Resources: Record<
    string,
    {
      Type: string;
      Properties: Record<string, unknown>;
      DeletionPolicy?: string;
    }
  >;
};

/**
 * スタックを合成する。Lambda のバンドル（esbuild）が走るため、ステージごとに 1 回だけ呼ぶ。
 *
 * @param stage - ステージ
 * @returns 合成したテンプレート
 */
function synth(stage: Stage): Template {
  const app = new App();
  return Template.fromStack(
    new BatchStack(app, `serverless-practice-app-${stage}`, { stage }),
  );
}

/**
 * SSM パラメータ（デプロイ時に解決する参照）の論理 ID を、パラメータ名から引く。
 *
 * @param json - テンプレート
 * @param name - SSM パラメータの名前（例: `/serverless-practice-app/local/queue/url`）
 * @returns その SSM パラメータを指す `Ref`
 */
function ssmRef(json: TemplateJson, name: string): { Ref: string } {
  const entry = Object.entries(json.Parameters).find(
    ([, p]) => p.Default === name,
  );
  if (entry === undefined) {
    throw new Error(`SSM パラメータ ${name} の参照がテンプレートに無い`);
  }
  return { Ref: entry[0] };
}

/**
 * ステートマシンの定義を JSON として読む。ARN などのトークン部分は `<TOKEN>` に置き換える。
 *
 * @param json - テンプレート
 * @returns ステートマシンの定義
 */
function stateMachineDefinition(json: TemplateJson): {
  StartAt: string;
  QueryLanguage: string;
  TimeoutSeconds: number;
  States: Record<
    string,
    {
      Next?: string;
      End?: boolean;
      Retry?: { ErrorEquals: string[]; MaxAttempts: number }[];
      Arguments: { Payload: string };
      Output: string;
    }
  >;
} {
  const machine = Object.values(json.Resources).find(
    (r) => r.Type === "AWS::StepFunctions::StateMachine",
  );
  // DefinitionString は { "Fn::Join": ["", [文字列 | トークン, ...]] } の形で合成される。
  // JSON.parse の戻り値は型が無いため、テストで読む形を戻り値の型として与える
  const join = (
    machine?.Properties.DefinitionString as { "Fn::Join": [string, unknown[]] }
  )["Fn::Join"][1];
  return JSON.parse(
    join.map((part) => (typeof part === "string" ? part : "<TOKEN>")).join(""),
  ) as ReturnType<typeof stateMachineDefinition>;
}

let template: Template;
let json: TemplateJson;

beforeAll(() => {
  // Template.toJSON() は型の無い値を返すため、テストで読む形（TemplateJson）だけを型として与える
  template = synth("local");
  json = template.toJSON() as TemplateJson;
}, 60_000);

describe("BatchStack（local）", () => {
  describe("正常系", () => {
    it.each([
      ["enqueue", 30],
      ["data-sync", 30],
      ["notify-slack", 10],
    ])(
      "%s は Node.js 22・arm64・256 MB・タイムアウト %i 秒で作る",
      (name, timeout) => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: `serverless-practice-app-local-${name}`,
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
          MemorySize: 256,
          Timeout: timeout,
        });
      },
    );

    it("環境変数で、投入にはキュー URL、データ連携にはバケット名を SSM から渡す", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "serverless-practice-app-local-enqueue",
        Environment: {
          Variables: Match.objectLike({
            STAGE: "local",
            QUEUE_URL: ssmRef(json, "/serverless-practice-app/local/queue/url"),
          }),
        },
      });
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "serverless-practice-app-local-data-sync",
        Environment: {
          Variables: Match.objectLike({
            BUCKET_NAME: ssmRef(
              json,
              "/serverless-practice-app/local/bucket/name",
            ),
          }),
        },
      });
    });

    it("ステートマシンは JSONata で Enqueue → DataSync を順に実行し、5 分でタイムアウトする", () => {
      const definition = stateMachineDefinition(json);

      expect(definition).toMatchObject({
        StartAt: "Enqueue",
        QueryLanguage: "JSONata",
        TimeoutSeconds: 300,
      });
      expect(definition.States.Enqueue?.Next).toBe("DataSync");
      expect(definition.States.DataSync?.End).toBe(true);
      template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        StateMachineName: "serverless-practice-app-local-batch",
        RoleArn: ssmRef(
          json,
          "/serverless-practice-app/local/role/state-machine/arn",
        ),
      });
    });

    it("タスク入力は実行入力に実行名を足したもの、タスクの出力は実行入力のまま次へ渡す", () => {
      const { States } = stateMachineDefinition(json);

      for (const state of [States.Enqueue, States.DataSync]) {
        expect(state?.Arguments.Payload).toBe(
          '{% $merge([$states.input, {"executionName": $states.context.Execution.Name}]) %}',
        );
        expect(state?.Output).toBe("{% $states.input %}");
      }
    });

    it("Consumer は SSM のキュー ARN から、5 件ずつ部分バッチ応答で受け取る", () => {
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        EventSourceArn: ssmRef(
          json,
          "/serverless-practice-app/local/queue/arn",
        ),
        BatchSize: 5,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      });
    });

    it("Schedule は Terraform の Schedule group に入れ、毎日 9:00（日本時間）に {} で起動する", () => {
      template.hasResourceProperties("AWS::Scheduler::Schedule", {
        Name: "serverless-practice-app-local-batch",
        GroupName: ssmRef(
          json,
          "/serverless-practice-app/local/schedule-group/name",
        ),
        ScheduleExpression: "cron(0 9 * * ? *)",
        ScheduleExpressionTimezone: "Asia/Tokyo",
        State: "ENABLED",
        Target: {
          RoleArn: ssmRef(
            json,
            "/serverless-practice-app/local/role/scheduler/arn",
          ),
          Input: "{}",
        },
      });
    });

    it("EventBridge rule は、このステートマシンの FAILED / TIMED_OUT / ABORTED を Slack 通知へ流す", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "serverless-practice-app-local-batch-failed",
        EventPattern: {
          source: ["aws.states"],
          "detail-type": ["Step Functions Execution Status Change"],
          detail: {
            status: ["FAILED", "TIMED_OUT", "ABORTED"],
            stateMachineArn: [Match.anyValue()],
          },
        },
        Targets: [Match.objectLike({ Arn: Match.anyValue() })],
      });
    });
  });

  describe("異常系（設定ずれの検出）", () => {
    it("IAM のロール・ポリシーを 1 つも作らない（権限は Terraform が持つ。grant* が足していない）", () => {
      template.resourceCountIs("AWS::IAM::Role", 0);
      template.resourceCountIs("AWS::IAM::Policy", 0);
      template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
    });

    it.each(["enqueue", "consumer", "data-sync", "notify-slack"])(
      "%s のロールは Terraform のロール（SSM の ARN）を使う",
      (name) => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: `serverless-practice-app-local-${name}`,
          Role: ssmRef(json, `/serverless-practice-app/local/role/${name}/arn`),
        });
      },
    );

    it("#18: Consumer のタイムアウトは SSM（consumer/timeout-seconds）から取り、値を直書きしない", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "serverless-practice-app-local-consumer",
        Timeout: ssmRef(
          json,
          "/serverless-practice-app/local/consumer/timeout-seconds",
        ),
      });
    });

    it("#19: どのタスクも InjectedFailureError・ValidationError を Retry しない", () => {
      const { States } = stateMachineDefinition(json);

      for (const state of [States.Enqueue, States.DataSync]) {
        const retried = (state?.Retry ?? []).flatMap(
          (retry) => retry.ErrorEquals,
        );
        expect(retried).not.toContain("InjectedFailureError");
        expect(retried).not.toContain("ValidationError");
        expect(retried).not.toContain("States.ALL");
      }
    });

    it("#19: EnqueuePartialFailureError を Retry するのは投入タスクだけで、回数は 2 回まで（CDK 既定の 6 回を使わない）", () => {
      const { States } = stateMachineDefinition(json);

      expect(States.Enqueue?.Retry).toEqual([
        expect.objectContaining({ MaxAttempts: 2 }),
      ]);
      expect(States.Enqueue?.Retry?.[0]?.ErrorEquals).toContain(
        "EnqueuePartialFailureError",
      );
      expect(States.DataSync?.Retry).toEqual([
        expect.objectContaining({ MaxAttempts: 2 }),
      ]);
      expect(States.DataSync?.Retry?.[0]?.ErrorEquals).not.toContain(
        "EnqueuePartialFailureError",
      );
    });

    it("ロググループは Terraform の権限と同じ名前で 7 日保持し、スタックの削除で一緒に消す", () => {
      for (const name of ["enqueue", "consumer", "data-sync", "notify-slack"]) {
        template.hasResource("AWS::Logs::LogGroup", {
          Properties: {
            LogGroupName: `/aws/lambda/serverless-practice-app-local-${name}`,
            RetentionInDays: 7,
          },
          DeletionPolicy: "Delete",
        });
      }
    });

    it("Lambda を外から呼べるのは EventBridge から Slack 通知への 1 つだけ", () => {
      template.resourceCountIs("AWS::Lambda::Permission", 1);
      template.hasResourceProperties("AWS::Lambda::Permission", {
        Principal: "events.amazonaws.com",
      });
    });
  });
});

describe("BatchStack（dev）", () => {
  it("ステージがリソース名と SSM パラメータのパスに入る（local の値を参照しない）", () => {
    const dev = synth("dev");
    const devJson = dev.toJSON() as TemplateJson;

    dev.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineName: "serverless-practice-app-dev-batch",
    });
    const defaults = Object.values(devJson.Parameters).flatMap((p) =>
      p.Default === undefined ? [] : [p.Default],
    );
    expect(
      defaults.filter((name) => name.startsWith("/serverless-practice-app/")),
    ).toHaveLength(11);
    expect(defaults.filter((name) => name.includes("/local/"))).toEqual([]);
  }, 60_000);
});

describe("parseStage", () => {
  it.each(["local", "dev"])("%s を受理する", (stage) => {
    expect(parseStage(stage)).toBe(stage);
  });

  it.each([undefined, "prod", "LOCAL", ""])(
    "%j は既定値に倒さず拒否する",
    (value) => {
      expect(() => parseStage(value)).toThrow(/-c stage=local\|dev/);
    },
  );
});
