import * as path from "node:path";
import { Duration, RemovalPolicy, Stack, Tags, Token } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import type { Stage } from "./stage";

/** リポジトリのルート。Lambda の entry と依存のロックファイルの基準 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** Lambda の関数名の <name> 部分。handler のファイル名と一致させる（docs/10「命名」） */
type FunctionName = "enqueue" | "consumer" | "data-sync" | "notify-slack";

/**
 * Step Functions が Retry する一時的なエラー（docs/04「リトライ」）。
 * 注入した失敗（InjectedFailureError）と検証エラー（ValidationError）は、何度やり直しても結果が同じなので含めない
 */
const TRANSIENT_LAMBDA_ERRORS = [
  "Lambda.ServiceException",
  "Lambda.AWSLambdaException",
  "Lambda.SdkClientException",
  "Lambda.TooManyRequestsException",
];

/**
 * 実行入力に実行名を足して、タスク入力を作る（docs/07「タスク入力」）。
 * JSONata の $merge を使うため、実行入力に failAt が無ければタスク入力にも無いまま渡る
 * （JSONPath の "$.failAt" のように、項目が無いだけで States.Runtime で落ちることがない）
 */
const TASK_PAYLOAD =
  '{% $merge([$states.input, {"executionName": $states.context.Execution.Name}]) %}';

/**
 * データ連携 Lambda のタスク入力。共通のタスク入力に、結果を返す宛先のタスクトークンを足す
 * （`.waitForTaskToken` で非同期に呼ぶため。docs/07「タスク入力」）
 */
const DATA_SYNC_TASK_PAYLOAD =
  '{% $merge([$states.input, {"executionName": $states.context.Execution.Name, "taskToken": $states.context.Task.Token}]) %}';

/**
 * LMI（Lambda Managed Instances）でデータ連携 Lambda を動かすステージ。
 * LocalStack の今のライセンスでは LMI の API を使えないため dev だけ（docs/09「LMI（Lambda Managed Instances）」）。
 * Terraform も同じ条件でキャパシティプロバイダを作る（infra/terraform/lmi.tf）
 */
const LMI_STAGES: readonly Stage[] = ["dev"];

/**
 * データ連携 Lambda のタイムアウト（秒）。LMI では非同期の呼び出しに限り 15 分を超えられる（最大 5,400 秒）。
 * LMI は検証用の待ち（holdSeconds の上限 1,200 秒）に処理の余裕を足した値、LMI を使わないステージは通常の Lambda の上限
 */
const DATA_SYNC_TIMEOUT_SECONDS = { lmi: 1800, standard: 900 } as const;

/**
 * `DataSync` タスクのタイムアウトに、関数のタイムアウトへ足す余裕（秒）。
 * LMI はタイムアウトしてもコードを止めないため、ステートマシン側で必ず打ち切る
 */
const DATA_SYNC_TASK_TIMEOUT_MARGIN_SECONDS = 60;

/** `DataSync` タスクのハートビートのタイムアウト（秒）。関数は待っている間 60 秒ごとに送る */
const DATA_SYNC_HEARTBEAT_SECONDS = 300;

/** データ連携 Lambda のメモリ（MB）。LMI の最小構成（2 GB・1 vCPU）。LMI を使わないステージも同じ値にそろえる */
const DATA_SYNC_MEMORY_MB = 2048;

/**
 * LMI の実行環境 1 つあたりのメモリ（vCPU あたりの GiB）。2 なら 2 GB の関数に 1 vCPU が割り当たる
 */
const LMI_MEMORY_GIB_PER_VCPU = 2;

/**
 * LMI で保つ実行環境の数。既定（最小 3）より台数を減らせるかを dev で確かめるため、最小・最大とも 1 にする
 * （docs/09「LMI（Lambda Managed Instances）」）
 */
const LMI_EXECUTION_ENVIRONMENTS = 1;

/**
 * タスクの出力を次のステートへ流さず、実行入力をそのまま渡す。
 * DataSync も実行入力の failAt を読めるようにするため（docs/07「データ連携 Lambda の出力」）
 */
const PASS_THROUGH_INPUT = "{% $states.input %}";

/**
 * BatchStack の設定。
 */
export type BatchStackProps = StackProps & {
  /** デプロイ先のステージ。リソース名・SSM パラメータのパスに入る */
  stage: Stage;
};

/**
 * アプリ側のリソース（Lambda 4 種・ステートマシン・Schedule・EventBridge rule）をまとめたスタック（docs/09「IaC の責務分担」）。
 *
 * Terraform が作った土台（IAM ロール・SQS・S3・Schedule group）は SSM パラメータから参照し、
 * このスタックでは IAM のロールもポリシーも作らない。ロールは mutable: false で参照するため、
 * CDK の grant* が権限を足そうとしても何も起きない（必要な権限は Terraform 側で明示済み）。
 */
export class BatchStack extends Stack {
  private readonly prefix: string;
  private readonly ssmPrefix: string;

  /**
   * @param scope - 親のコンストラクト（App）
   * @param id - スタックの ID
   * @param props - スタックの設定
   */
  constructor(scope: Construct, id: string, props: BatchStackProps) {
    super(scope, id, props);
    const { stage } = props;
    this.prefix = `serverless-practice-app-${stage}`;
    this.ssmPrefix = `/serverless-practice-app/${stage}`;

    Tags.of(this).add("Project", "serverless-practice-app");
    Tags.of(this).add("Stage", stage);
    Tags.of(this).add("ManagedBy", "cdk");

    // ---- Lambda 4 種（タイムアウトは docs/04「パフォーマンス要件」）----
    const enqueue = this.createFunction("EnqueueFunction", "enqueue", stage, {
      timeout: Duration.seconds(30),
      environment: { QUEUE_URL: this.ssmValue("queue/url") },
    });
    const consumer = this.createFunction(
      "ConsumerFunction",
      "consumer",
      stage,
      {
        // 正本は Terraform。SQS の可視性タイムアウトはこの 6 倍で、値を CDK に書かないことで両者がずれない（docs/04）
        timeout: Duration.seconds(
          Token.asNumber(this.ssmValue("consumer/timeout-seconds")),
        ),
        environment: {},
      },
    );
    const useLmi = LMI_STAGES.includes(stage);
    const dataSyncTimeoutSeconds = useLmi
      ? DATA_SYNC_TIMEOUT_SECONDS.lmi
      : DATA_SYNC_TIMEOUT_SECONDS.standard;
    const dataSync = this.createFunction(
      "DataSyncFunction",
      "data-sync",
      stage,
      {
        timeout: Duration.seconds(dataSyncTimeoutSeconds),
        memorySize: DATA_SYNC_MEMORY_MB,
        // 非同期の呼び出しの再試行（既定 2 回）を止め、同じタスクトークンで処理を二重に走らせない。
        // 関数は結果を返したら投げない作りだが、設定でも止める（LMI の $LATEST.PUBLISHED に効くかは dev で確かめる）
        retryAttempts: 0,
        // LMI は AWS SDK v3 3.933.0 以上を求める。ランタイム同梱の SDK の版に頼らず、ロックファイルの版を同梱する
        bundleAwsSdk: true,
        environment: { BUCKET_NAME: this.ssmValue("bucket/name") },
      },
    );
    if (useLmi) {
      this.attachCapacityProvider(dataSync);
    }
    const notifySlack = this.createFunction(
      "NotifySlackFunction",
      "notify-slack",
      stage,
      {
        timeout: Duration.seconds(10),
        environment: {},
      },
    );

    // ---- SQS イベントソース（docs/03「Consumer Lambda」）----
    const mailQueue = sqs.Queue.fromQueueAttributes(this, "MailQueue", {
      queueArn: this.ssmValue("queue/arn"),
      fifo: true,
    });
    consumer.addEventSource(
      new SqsEventSource(mailQueue, {
        batchSize: 5,
        // 失敗したメッセージだけを再配信させる（部分バッチ応答）
        reportBatchItemFailures: true,
      }),
    );

    // ---- ステートマシン（docs/03「ステートマシン」）----
    const enqueueTask = this.createInvokeTask("Enqueue", enqueue, [
      ...TRANSIENT_LAMBDA_ERRORS,
      // 一部が送れなかった投入は送り直す。重複排除 ID が決定的なため、送信済みの分は重複しない（docs/04）
      "EnqueuePartialFailureError",
    ]);
    const dataSyncTask = this.createCallbackTask(
      "DataSync",
      dataSync,
      TRANSIENT_LAMBDA_ERRORS,
      dataSyncTimeoutSeconds + DATA_SYNC_TASK_TIMEOUT_MARGIN_SECONDS,
    );

    const stateMachine = new sfn.StateMachine(this, "BatchStateMachine", {
      stateMachineName: `${this.prefix}-batch`,
      queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(
        enqueueTask.next(dataSyncTask),
      ),
      // 超えたら TIMED_OUT で通知に乗せる（docs/04）。投入（Retry を含む）と DataSync のタイムアウトの合計より長くする
      timeout: Duration.minutes(40),
      role: this.importRole("StateMachineRole", "role/state-machine/arn"),
    });

    // ---- 定時起動（docs/02「F-1」）----
    new scheduler.CfnSchedule(this, "BatchSchedule", {
      name: `${this.prefix}-batch`,
      groupName: this.ssmValue("schedule-group/name"),
      // 毎日 9:00（日本時間）に起動する
      scheduleExpression: "cron(0 9 * * ? *)",
      scheduleExpressionTimezone: "Asia/Tokyo",
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: {
        arn: stateMachine.stateMachineArn,
        roleArn: this.ssmValue("role/scheduler/arn"),
        // 定時起動では失敗を注入しない
        input: "{}",
      },
    });

    // ---- 失敗通知（docs/02「F-5」）----
    new events.Rule(this, "BatchFailureRule", {
      ruleName: `${this.prefix}-batch-failed`,
      eventPattern: {
        source: ["aws.states"],
        detailType: ["Step Functions Execution Status Change"],
        detail: {
          status: ["FAILED", "TIMED_OUT", "ABORTED"],
          stateMachineArn: [stateMachine.stateMachineArn],
        },
      },
      // ターゲットの追加で付くのは Lambda 側のリソースベースポリシー（呼び出しの許可）で、IAM ロールは変えない
      targets: [new eventsTargets.LambdaFunction(notifySlack)],
    });
  }

  /**
   * Terraform が書いた SSM パラメータの値を、デプロイ時に解決する参照として取り出す。
   * 合成時に読む方式（valueFromLookup）は値が cdk.context.json にキャッシュされ、ステージ間で混ざりうるため使わない。
   *
   * @param name - `/serverless-practice-app/<stage>/` より後ろの名前（例: `queue/url`）
   * @returns デプロイ時に解決される値のトークン
   */
  private ssmValue(name: string): string {
    return ssm.StringParameter.valueForStringParameter(
      this,
      `${this.ssmPrefix}/${name}`,
    );
  }

  /**
   * Terraform が作った IAM ロールを、権限を足せない形で参照する。
   *
   * @param id - コンストラクトの ID
   * @param ssmName - ロール ARN を持つ SSM パラメータの名前
   * @returns 変更できないロール。grant* で権限を足そうとしても何も起きない
   */
  private importRole(id: string, ssmName: string): iam.IRole {
    return iam.Role.fromRoleArn(this, id, this.ssmValue(ssmName), {
      mutable: false,
    });
  }

  /**
   * Lambda を 1 つ作る。共通の設定（ランタイム・メモリ・ロググループ・バンドル）はここで揃える。
   *
   * @param id - コンストラクトの ID
   * @param name - 関数名の <name> 部分。handler のファイル名と一致させる
   * @param stage - ステージ。環境変数 STAGE に渡す
   * @param options - 関数ごとに違う設定
   * @param options.timeout - タイムアウト
   * @param options.environment - STAGE 以外の環境変数
   * @param options.memorySize - メモリ（MB）。省略時は 256（docs/04「パフォーマンス要件」）
   * @param options.retryAttempts - 非同期の呼び出しの再試行回数。省略時は Lambda の既定（2 回）
   * @param options.bundleAwsSdk - AWS SDK を同梱するなら true。省略時はランタイム同梱の SDK を使う
   * @returns 作った Lambda
   */
  private createFunction(
    id: string,
    name: FunctionName,
    stage: Stage,
    options: {
      timeout: Duration;
      environment: Record<string, string>;
      memorySize?: number;
      retryAttempts?: number;
      bundleAwsSdk?: boolean;
    },
  ): nodejs.NodejsFunction {
    const functionName = `${this.prefix}-${name}`;
    return new nodejs.NodejsFunction(this, id, {
      functionName,
      entry: path.join(REPO_ROOT, "functions/src/handlers", `${name}.ts`),
      handler: "handler",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: options.memorySize ?? 256,
      timeout: options.timeout,
      ...(options.retryAttempts === undefined
        ? {}
        : { retryAttempts: options.retryAttempts }),
      role: this.importRole(`${id}Role`, `role/${name}/arn`),
      // Terraform のポリシーが書き込みを許すロググループの名前に合わせ、削除時に一緒に消す（docs/04「保持期間」）
      logGroup: new logs.LogGroup(this, `${id}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        STAGE: stage,
        // エラーのスタックトレースを TypeScript の行で出す
        NODE_OPTIONS: "--enable-source-maps",
        ...options.environment,
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node22",
        sourceMap: true,
        // エラー名は文字列で固定している（functions/src/errors）ため、minify でクラス名が変わっても
        // Step Functions の Retry 判定（errorType）は崩れない。スタックトレースはソースマップで元の行に戻る
        minify: true,
        // 既定ではランタイム同梱の AWS SDK を使い、バンドルに含めない。
        // 同梱すると SDK 内の CommonJS の require("node:https") が ESM の出力に入り、ESM には require が無いため
        // 起動時に "Dynamic require of "node:https" is not supported" で落ちる（2026-10-13 に LocalStack で確認）。
        // 出力の先頭で require を用意する
        ...(options.bundleAwsSdk === true
          ? {
              externalModules: [],
              banner:
                "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
            }
          : {}),
      },
    });
  }

  /**
   * Terraform が作ったキャパシティプロバイダに関数を紐付け、LMI で動かす（docs/09「LMI（Lambda Managed Instances）」）。
   * 読み込んだプロバイダ（ICapacityProvider）には addFunction が無いため、CapacityProvider.addFunction と同じ設定を L1 に書く。
   * 紐付けると関数の $LATEST.PUBLISHED が公開され、修飾子なしの呼び出しはそこへ向かう
   *
   * @param fn - 紐付ける関数
   */
  private attachCapacityProvider(fn: nodejs.NodejsFunction): void {
    // NodejsFunction の既定の子は必ず CfnFunction（lambda.Function が作る L1）。型は IConstruct のため絞り込む
    const cfnFunction = fn.node.defaultChild as lambda.CfnFunction;
    cfnFunction.capacityProviderConfig = {
      lambdaManagedInstancesCapacityProviderConfig: {
        capacityProviderArn: this.ssmValue("capacity-provider/arn"),
        executionEnvironmentMemoryGiBPerVCpu: LMI_MEMORY_GIB_PER_VCPU,
      },
    };
    cfnFunction.publishToLatestPublished = true;
    cfnFunction.functionScalingConfig = {
      minExecutionEnvironments: LMI_EXECUTION_ENVIRONMENTS,
      maxExecutionEnvironments: LMI_EXECUTION_ENVIRONMENTS,
    };
  }

  /**
   * Lambda を呼ぶタスクを作る。Retry は指定したエラーだけに付け、CDK 既定の Retry は使わない。
   *
   * @param id - ステート名
   * @param fn - 呼ぶ Lambda
   * @param retryErrors - Retry するエラー名
   * @returns タスク
   */
  private createInvokeTask(
    id: string,
    fn: lambda.IFunction,
    retryErrors: string[],
  ): tasks.LambdaInvoke {
    const task = tasks.LambdaInvoke.jsonata(this, id, {
      lambdaFunction: fn,
      payload: sfn.TaskInput.fromText(TASK_PAYLOAD),
      outputs: PASS_THROUGH_INPUT,
      // 既定の Retry（最大 6 回）を外し、docs/04 の回数・対象で付け直す
      retryOnServiceExceptions: false,
    });
    this.addRetry(task, retryErrors);
    return task;
  }

  /**
   * Lambda を非同期に呼び、関数がタスクトークンで結果を返すまで待つタスクを作る（`.waitForTaskToken`）。
   * LMI で 15 分を超えて動けるのは非同期の呼び出しだけのため（docs/09「LMI（Lambda Managed Instances）」）。
   * 関数が結果を返さずに止まっても待ち続けないよう、タイムアウトとハートビートを必ず付ける
   *
   * @param id - ステート名
   * @param fn - 呼ぶ Lambda
   * @param retryErrors - Retry するエラー名（呼び出しそのものの失敗と、関数が SendTaskFailure で返したエラー名の両方に効く）
   * @param timeoutSeconds - タスクのタイムアウト（秒）
   * @returns タスク
   */
  private createCallbackTask(
    id: string,
    fn: lambda.IFunction,
    retryErrors: string[],
    timeoutSeconds: number,
  ): tasks.LambdaInvoke {
    const task = tasks.LambdaInvoke.jsonata(this, id, {
      lambdaFunction: fn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      invocationType: tasks.LambdaInvocationType.EVENT,
      payload: sfn.TaskInput.fromText(DATA_SYNC_TASK_PAYLOAD),
      outputs: PASS_THROUGH_INPUT,
      taskTimeout: sfn.Timeout.duration(Duration.seconds(timeoutSeconds)),
      heartbeatTimeout: sfn.Timeout.duration(
        Duration.seconds(DATA_SYNC_HEARTBEAT_SECONDS),
      ),
      retryOnServiceExceptions: false,
    });
    this.addRetry(task, retryErrors);
    return task;
  }

  /**
   * 一時的なエラーにだけ Retry を付ける（docs/04「リトライ」）。
   *
   * @param task - Retry を付けるタスク
   * @param retryErrors - Retry するエラー名
   */
  private addRetry(task: tasks.LambdaInvoke, retryErrors: string[]): void {
    task.addRetry({
      errors: retryErrors,
      interval: Duration.seconds(2),
      maxAttempts: 2,
      backoffRate: 2,
    });
  }
}
