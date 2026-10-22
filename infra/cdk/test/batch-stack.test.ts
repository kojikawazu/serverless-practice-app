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
      Resource: string;
      TimeoutSeconds?: number;
      HeartbeatSeconds?: number;
      Arguments: { Payload: string; InvocationType?: string };
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

/**
 * アラームの論理 ID を、アラーム名から引く。rule のパターンが指すアラーム（`Ref`）を突き合わせるために使う。
 *
 * @param json - テンプレート
 * @param alarmName - アラーム名
 * @returns そのアラームの論理 ID
 */
function alarmLogicalId(json: TemplateJson, alarmName: string): string {
  const entry = Object.entries(json.Resources).find(
    ([, r]) =>
      r.Type === "AWS::CloudWatch::Alarm" &&
      r.Properties.AlarmName === alarmName,
  );
  if (entry === undefined) {
    throw new Error(`アラーム ${alarmName} がテンプレートに無い`);
  }
  return entry[0];
}

/**
 * rule のパターンが指すアラーム名（`detail.alarmName`）を、rule 名から引く。
 *
 * @param json - テンプレート
 * @param ruleName - rule 名
 * @returns パターンの `detail.alarmName`
 */
function ruleAlarmNames(json: TemplateJson, ruleName: string): unknown {
  const rule = Object.values(json.Resources).find(
    (r) => r.Type === "AWS::Events::Rule" && r.Properties.Name === ruleName,
  );
  if (rule === undefined) {
    throw new Error(`rule ${ruleName} がテンプレートに無い`);
  }
  // EventPattern は型の無い JSON のため、読む形だけを与える
  return (rule.Properties.EventPattern as { detail: { alarmName: unknown } })
    .detail.alarmName;
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
      ["enqueue", 256, 30],
      ["data-sync", 2048, 900],
      ["notify-slack", 256, 10],
    ])(
      "%s は Node.js 22・arm64・%i MB・タイムアウト %i 秒で作る",
      (name, memory, timeout) => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: `serverless-practice-app-local-${name}`,
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
          MemorySize: memory,
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

    it("ステートマシンは JSONata で Enqueue → DataSync を順に実行し、40 分でタイムアウトする", () => {
      const definition = stateMachineDefinition(json);

      expect(definition).toMatchObject({
        StartAt: "Enqueue",
        QueryLanguage: "JSONata",
        TimeoutSeconds: 2400,
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

    it("タスク入力は実行入力に実行名を足したもの（DataSync はタスクトークンも足す）、タスクの出力は実行入力のまま次へ渡す", () => {
      const { States } = stateMachineDefinition(json);

      expect(States.Enqueue?.Arguments.Payload).toBe(
        '{% $merge([$states.input, {"executionName": $states.context.Execution.Name}]) %}',
      );
      expect(States.DataSync?.Arguments.Payload).toBe(
        '{% $merge([$states.input, {"executionName": $states.context.Execution.Name, "taskToken": $states.context.Task.Token}]) %}',
      );
      for (const state of [States.Enqueue, States.DataSync]) {
        expect(state?.Output).toBe("{% $states.input %}");
      }
    });

    it("投入は同期で呼び、DataSync は非同期で呼んで関数がタスクトークンで結果を返すまで待つ", () => {
      const { States } = stateMachineDefinition(json);

      expect(States.Enqueue?.Resource).toMatch(/:states:::lambda:invoke$/);
      expect(States.Enqueue?.Arguments.InvocationType).toBeUndefined();
      expect(States.DataSync?.Resource).toMatch(
        /:states:::lambda:invoke\.waitForTaskToken$/,
      );
      expect(States.DataSync?.Arguments.InvocationType).toBe("Event");
    });

    it("DataSync は関数のタイムアウト（900 秒）に 60 秒を足して打ち切り、ハートビートが 300 秒途切れても打ち切る", () => {
      const { States } = stateMachineDefinition(json);

      expect(States.DataSync).toMatchObject({
        TimeoutSeconds: 960,
        HeartbeatSeconds: 300,
      });
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

    it("#101: Schedule は起動に失敗した呼び出しを Terraform の DLQ（SSM の ARN）へ送る", () => {
      template.hasResourceProperties("AWS::Scheduler::Schedule", {
        Target: {
          DeadLetterConfig: {
            Arn: ssmRef(
              json,
              "/serverless-practice-app/local/scheduler-dlq/arn",
            ),
          },
        },
      });
    });

    it("#101: DLQ のアラームは、5 分間に 1 件でも届いたら ALARM にし、届かない期間は ALARM にしない", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "serverless-practice-app-local-scheduler-dlq",
        Namespace: "AWS/SQS",
        Dimensions: [
          {
            Name: "QueueName",
            Value: ssmRef(
              json,
              "/serverless-practice-app/local/scheduler-dlq/name",
            ),
          },
        ],
        Statistic: "Sum",
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
      });
    });

    it("#101: EventBridge rule は、DLQ のアラームが ALARM になったことを Slack 通知へ流す", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "serverless-practice-app-local-scheduler-dlq-alarm",
        EventPattern: {
          source: ["aws.cloudwatch"],
          "detail-type": ["CloudWatch Alarm State Change"],
          detail: {
            alarmName: [Match.anyValue()],
            state: { value: ["ALARM"] },
          },
        },
        Targets: [Match.objectLike({ Arn: Match.anyValue() })],
      });
    });

    it("#109: 実行が始まらない日のアラームは、Scheduler の起動の試みを日本時間の 1 日ごとに数え、0 回の日（データの無い日を含む）を ALARM にする", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "serverless-practice-app-local-scheduler-missed-run",
        Namespace: "AWS/Scheduler",
        MetricName: "InvocationAttemptCount",
        Dimensions: [
          {
            Name: "ScheduleGroup",
            Value: ssmRef(
              json,
              "/serverless-practice-app/local/schedule-group/name",
            ),
          },
        ],
        Statistic: "Sum",
        Period: 86400,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: "LessThanThreshold",
        TreatMissingData: "breaching",
        EvaluationWindow: { WallClockWindow: { Timezone: "Asia/Tokyo" } },
      });
    });

    it("#109: 実行が始まらない日のアラームは、作ってから 2 日（上限）経つまで評価しない", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "serverless-practice-app-local-scheduler-missed-run",
        WarmUpConfiguration: {
          WarmUpPeriodDurationInMinutes: 2880,
          OnlyStartEvaluatingAfterWarmUpPeriodEnds: true,
        },
      });
    });

    it("#109: EventBridge rule は、実行が始まらない日のアラームが ALARM になったことを Slack 通知へ流す", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "serverless-practice-app-local-scheduler-missed-run-alarm",
        EventPattern: {
          source: ["aws.cloudwatch"],
          "detail-type": ["CloudWatch Alarm State Change"],
          detail: {
            alarmName: [
              {
                Ref: alarmLogicalId(
                  json,
                  "serverless-practice-app-local-scheduler-missed-run",
                ),
              },
            ],
            state: { value: ["ALARM"] },
          },
        },
        Targets: [Match.objectLike({ Arn: Match.anyValue() })],
      });
    });
  });

  describe("異常系（設定ずれの検出）", () => {
    // メッセージ数（ApproximateNumberOfMessagesVisible）は DLQ を空にするまで減らず、ALARM のままになって次の失敗を通知しない
    it("#101: DLQ のアラームはメッセージ数ではなく、届いた数（NumberOfMessagesSent）で数える", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "serverless-practice-app-local-scheduler-dlq",
        MetricName: "NumberOfMessagesSent",
      });
    });

    it("#109: アラームは DLQ の送信数と、実行が始まらない日の 2 つだけ", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    });

    // ExecutionsStarted は手動の実行（batch.sh run）も数えるため、その日に手動の実行があると定時の起動の欠けが隠れる
    it("#109: 実行が始まらない日は、Step Functions の実行数（AWS/States）ではなく、Scheduler の起動の試みで数える", () => {
      for (const alarm of Object.values(json.Resources).filter(
        (r) => r.Type === "AWS::CloudWatch::Alarm",
      )) {
        expect(alarm.Properties.Namespace).not.toBe("AWS/States");
      }
    });

    // アラームは ScheduleGroup 単位でしか数えられない。2 本目があると、片方が止まっても合計が 1 以上になり気づけない
    it("#109: Schedule は 1 本だけ（実行が始まらない日のアラームの前提）", () => {
      template.resourceCountIs("AWS::Scheduler::Schedule", 1);
    });

    // ずれると、9:00 の起動が評価の 1 日をまたいで数えられ、起動した日にも ALARM になる
    it("#109: アラームの 1 日の区切りは、Schedule と同じタイムゾーン", () => {
      const schedule = Object.values(json.Resources).find(
        (r) => r.Type === "AWS::Scheduler::Schedule",
      );
      const alarm =
        json.Resources[
          alarmLogicalId(
            json,
            "serverless-practice-app-local-scheduler-missed-run",
          )
        ];
      expect(alarm?.Properties.EvaluationWindow).toEqual({
        WallClockWindow: {
          Timezone: schedule?.Properties.ScheduleExpressionTimezone,
        },
      });
    });

    it("#109: 2 つのアラームの rule は、それぞれ自分のアラームだけを流す（取り違えない）", () => {
      expect(
        ruleAlarmNames(
          json,
          "serverless-practice-app-local-scheduler-dlq-alarm",
        ),
      ).toEqual([
        {
          Ref: alarmLogicalId(
            json,
            "serverless-practice-app-local-scheduler-dlq",
          ),
        },
      ]);
      expect(
        ruleAlarmNames(
          json,
          "serverless-practice-app-local-scheduler-missed-run-alarm",
        ),
      ).toEqual([
        {
          Ref: alarmLogicalId(
            json,
            "serverless-practice-app-local-scheduler-missed-run",
          ),
        },
      ]);
    });

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

    it("#92: Schedule の再試行は 185 回・24 時間と明示する（既定に頼らず、dev で観測した既定と同じ値にする）", () => {
      template.hasResourceProperties("AWS::Scheduler::Schedule", {
        Target: {
          RetryPolicy: {
            MaximumRetryAttempts: 185,
            MaximumEventAgeInSeconds: 86400,
          },
        },
      });
    });

    it("#90: ステートマシンの種類は Standard（.waitForTaskToken と状態変化イベントは Standard でしか使えない）", () => {
      template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        StateMachineType: "STANDARD",
      });
    });

    it("#90: 一時的なエラーとして Retry するのは、呼び出しが関数に届いていないと分かる 4 つだけ（ClientExecutionTimeoutException は含めない）", () => {
      const { States } = stateMachineDefinition(json);
      const transient = [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ];

      expect(States.Enqueue?.Retry?.[0]?.ErrorEquals).toEqual([
        ...transient,
        "EnqueuePartialFailureError",
      ]);
      expect(States.DataSync?.Retry?.[0]?.ErrorEquals).toEqual(transient);
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

    it("データ連携 Lambda は非同期の呼び出しを再試行しない（同じタスクトークンで二重に走らせない）", () => {
      template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 1);
      template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
        FunctionName: Match.anyValue(),
        Qualifier: "$LATEST",
        MaximumRetryAttempts: 0,
      });
    });

    it("local ではどの関数も LMI に紐付けない（LocalStack のライセンスで LMI の API を使えない）", () => {
      for (const fn of Object.values(json.Resources).filter(
        (r) => r.Type === "AWS::Lambda::Function",
      )) {
        expect(fn.Properties.CapacityProviderConfig).toBeUndefined();
      }
    });

    it("Lambda を外から呼べるのは、EventBridge の 3 つの rule から Slack 通知への呼び出しだけ", () => {
      template.resourceCountIs("AWS::Lambda::Permission", 3);
      const permissions = Object.values(json.Resources).filter(
        (r) => r.Type === "AWS::Lambda::Permission",
      );
      expect(permissions.map((p) => p.Properties.Principal)).toEqual([
        "events.amazonaws.com",
        "events.amazonaws.com",
        "events.amazonaws.com",
      ]);
    });
  });
});

describe("BatchStack（dev）", () => {
  let dev: Template;
  let devJson: TemplateJson;

  beforeAll(() => {
    dev = synth("dev");
    devJson = dev.toJSON() as TemplateJson;
  }, 60_000);

  it("ステージがリソース名と SSM パラメータのパスに入る（local の値を参照しない）", () => {
    dev.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineName: "serverless-practice-app-dev-batch",
    });
    const defaults = Object.values(devJson.Parameters).flatMap((p) =>
      p.Default === undefined ? [] : [p.Default],
    );
    // local の 13 個（Scheduler の DLQ の ARN・名前を含む）に、LMI のキャパシティプロバイダの ARN を足した 14 個
    expect(
      defaults.filter((name) => name.startsWith("/serverless-practice-app/")),
    ).toHaveLength(14);
    expect(defaults.filter((name) => name.includes("/local/"))).toEqual([]);
  });

  it("データ連携 Lambda を Terraform のキャパシティプロバイダ（SSM の ARN）に紐付け、実行環境を 1 つだけ保つ", () => {
    dev.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "serverless-practice-app-dev-data-sync",
      MemorySize: 2048,
      Timeout: 1800,
      CapacityProviderConfig: {
        LambdaManagedInstancesCapacityProviderConfig: {
          CapacityProviderArn: ssmRef(
            devJson,
            "/serverless-practice-app/dev/capacity-provider/arn",
          ),
          ExecutionEnvironmentMemoryGiBPerVCpu: 2,
        },
      },
      PublishToLatestPublished: true,
      FunctionScalingConfig: {
        MinExecutionEnvironments: 1,
        MaxExecutionEnvironments: 1,
      },
    });
  });

  it("LMI に紐付けるのはデータ連携 Lambda だけ", () => {
    const attached = Object.values(devJson.Resources).flatMap((r) =>
      r.Type === "AWS::Lambda::Function" &&
      r.Properties.CapacityProviderConfig !== undefined
        ? [r.Properties.FunctionName]
        : [],
    );
    expect(attached).toEqual(["serverless-practice-app-dev-data-sync"]);
  });

  it("DataSync は関数のタイムアウト（1,800 秒。LMI で 15 分を超える）に 60 秒を足して打ち切る", () => {
    const { States } = stateMachineDefinition(devJson);

    expect(States.DataSync).toMatchObject({
      TimeoutSeconds: 1860,
      HeartbeatSeconds: 300,
    });
  });
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
