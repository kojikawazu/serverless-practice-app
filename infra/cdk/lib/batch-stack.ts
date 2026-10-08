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
    const dataSync = this.createFunction(
      "DataSyncFunction",
      "data-sync",
      stage,
      {
        timeout: Duration.seconds(30),
        environment: { BUCKET_NAME: this.ssmValue("bucket/name") },
      },
    );
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
    const dataSyncTask = this.createInvokeTask(
      "DataSync",
      dataSync,
      TRANSIENT_LAMBDA_ERRORS,
    );

    const stateMachine = new sfn.StateMachine(this, "BatchStateMachine", {
      stateMachineName: `${this.prefix}-batch`,
      queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(
        enqueueTask.next(dataSyncTask),
      ),
      // 超えたら TIMED_OUT で通知に乗せる（docs/04）
      timeout: Duration.minutes(5),
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
   * @returns 作った Lambda
   */
  private createFunction(
    id: string,
    name: FunctionName,
    stage: Stage,
    options: { timeout: Duration; environment: Record<string, string> },
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
      memorySize: 256,
      timeout: options.timeout,
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
      },
    });
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
    task.addRetry({
      errors: retryErrors,
      interval: Duration.seconds(2),
      maxAttempts: 2,
      backoffRate: 2,
    });
    return task;
  }
}
