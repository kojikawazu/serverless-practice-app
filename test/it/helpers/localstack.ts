import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { FilterLogEventsCommandOutput } from "@aws-sdk/client-cloudwatch-logs";
import {
  GetEventSourceMappingCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
} from "@aws-sdk/client-lambda";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  DescribeExecutionCommand,
  ListStateMachinesCommand,
  SFNClient,
  DescribeStateMachineCommand,
  GetExecutionHistoryCommand,
  StartExecutionCommand,
  StopExecutionCommand,
  UpdateStateMachineCommand,
} from "@aws-sdk/client-sfn";
import type { DescribeExecutionCommandOutput } from "@aws-sdk/client-sfn";
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { z } from "zod";

/** IT の対象ステージ。IT は LocalStack 専用で、実 AWS（dev）には向けない */
const STAGE = "local";

/** リソース名の接頭辞（docs/10「命名」） */
const PREFIX = `serverless-practice-app-${STAGE}`;

/**
 * SDK の共通設定。接続先は LocalStack に固定し、認証情報もダミーにする。
 * 手元の AWS プロファイル（実 AWS の認証情報）を読ませないため、認証情報を明示する。
 * 接続先の環境変数名・既定値は scripts/lib/aws-stage.sh と揃える
 */
const CLIENT_CONFIG = {
  endpoint: process.env.LOCALSTACK_ENDPOINT ?? "http://127.0.0.1:4566",
  region: "ap-northeast-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

const sfn = new SFNClient(CLIENT_CONFIG);
const lambda = new LambdaClient(CLIENT_CONFIG);
const logs = new CloudWatchLogsClient(CLIENT_CONFIG);
const s3 = createS3Client();
const sqs = new SQSClient(CLIENT_CONFIG);
const ssm = new SSMClient(CLIENT_CONFIG);

/**
 * 実行全体のタイムアウトを越えさせるために、定義の先頭へ足す Wait ステートの名前。
 * IT が中断して定義が書き換わったまま残っても、この名前で見つけて戻せる
 */
const TIMEOUT_WAIT_STATE = "ItTimeoutWait";

/** 書き換えた定義の、実行全体のタイムアウト（秒） */
const SHORTENED_TIMEOUT_SECONDS = 2;

/** 足す Wait ステートの待ち時間（秒）。タイムアウトより十分長くし、Wait の途中で必ず TIMED_OUT にする */
const TIMEOUT_WAIT_SECONDS = 10;

/**
 * ステートマシンの定義（ASL）のうち、タイムアウトの書き換えで触る項目。
 * それ以外の項目（QueryLanguage など）は読み書きの間そのまま保つ
 */
const definitionSchema = z.looseObject({
  StartAt: z.string(),
  /** 実行全体のタイムアウト（秒）。省略は「タイムアウトなし」 */
  TimeoutSeconds: z.number().optional(),
  States: z.record(z.string(), z.unknown()),
});

/** ステートマシンの定義（ASL）。タイムアウトの書き換えで触る項目だけを型にする */
type Definition = z.infer<typeof definitionSchema>;

/**
 * 書き換えのとき Wait ステートの Comment に残す、元の定義の値。
 * 元のタイムアウトを IT に書き写さずに戻すため、書き換えた定義そのものに持たせる
 */
const timeoutBackupSchema = z.object({
  /** 元の実行全体のタイムアウト（秒）。`null` は元の定義に TimeoutSeconds が無かったこと */
  TimeoutSeconds: z.number().nullable(),
});

/** ハートビートの書き換えで触るタスクのステート名（docs/03「ステートマシン」） */
const DATA_SYNC_STATE = "DataSync";

/**
 * 書き換えた定義の、`DataSync` のハートビートのタイムアウト（秒）。
 * データ連携 Lambda は待ちの始めに 1 回ハートビートを送り、次は 60 秒後に送るため、
 * `holdSeconds` をこれより長くすれば、結果を返す前に必ずハートビートが切れる
 */
const SHORTENED_HEARTBEAT_SECONDS = 2;

/**
 * 書き換えのとき `DataSync` の Comment に残す、元の定義の値。
 * 元のハートビートを IT に書き写さずに戻すため、書き換えた定義そのものに持たせる。
 * キー名は、IT が書き換えた印も兼ねる（元の定義の Comment と区別する）
 */
const heartbeatBackupSchema = z.object({
  itHeartbeatBackup: z.object({
    /** 元のハートビートのタイムアウト（秒） */
    HeartbeatSeconds: z.number(),
    /** 元の Comment。`null` は元の定義に Comment が無かったこと */
    Comment: z.string().nullable(),
  }),
});

/** `DataSync` のうち、ハートビートの書き換えで触る項目。それ以外はそのまま保つ */
const taskStateSchema = z.looseObject({
  HeartbeatSeconds: z.number().optional(),
  Comment: z.string().optional(),
});

/** Lambda の関数名の <name> 部分 */
export type FunctionName =
  "enqueue" | "consumer" | "data-sync" | "notify-slack";

/** スタブが出す構造化ログの 1 行。IT が読む項目だけを型にする */
export type StubLog = {
  /** どのスタブの出力か（docs/07「スタブへの出力」） */
  stub: string;
  executionName: string;
  [key: string]: unknown;
};

/** IT が操作する、デプロイ済みのリソース */
export type DeployedResources = {
  stateMachineArn: string;
  /** データ連携の出力先バケット */
  bucketName: string;
  /** メール送信キューの URL */
  queueUrl: string;
  /** メール送信キューの DLQ の URL */
  dlqUrl: string;
  /** Consumer をメール送信キューにつなぐイベントソースマッピングの UUID */
  consumerEventSourceUuid: string;
};

/**
 * LocalStack の S3 クライアントを作る。
 *
 * @param accountId - 操作するアカウントの ID（12 桁）。省略すると既定のアカウント（000000000000）。
 *   LocalStack は、アクセスキーが 12 桁の数字ならそれをアカウント ID として扱う
 * @returns S3 クライアント
 */
export function createS3Client(accountId?: string): S3Client {
  return new S3Client({
    ...CLIENT_CONFIG,
    ...(accountId === undefined
      ? {}
      : { credentials: { accessKeyId: accountId, secretAccessKey: "test" } }),
    // LocalStack はバケット名のサブドメイン形式を解決できないため、パス形式で接続する
    forcePathStyle: true,
  });
}

/**
 * 待つ。
 *
 * @param ms - 待つ時間（ミリ秒）
 * @returns 待ち終えたら解決する
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 条件を満たす値が得られるまで、間隔を空けて取得を繰り返す。
 *
 * @param fetch - 値を取得する
 * @param done - 取得した値が条件を満たすか
 * @param timeoutMs - 待つ最大時間（ミリ秒）
 * @param intervalMs - 取得の間隔（ミリ秒）
 * @returns 条件を満たした値
 * @throws {Error} 待っても条件を満たさなかった場合（最後に取得した値を含める）
 */
export async function pollUntil<T>(
  fetch: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fetch();
    if (done(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${timeoutMs} ms 待っても条件を満たしませんでした。最後の値: ${JSON.stringify(value)}`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * SSM パラメータ（Terraform → CDK の受け渡し）の値を読む。
 *
 * @param name - `/serverless-practice-app/local/` より後ろの名前
 * @returns 値
 * @throws {Error} パラメータが無い場合（Terraform が未適用）
 */
async function ssmValue(name: string): Promise<string> {
  const { Parameter } = await ssm.send(
    new GetParameterCommand({
      Name: `/serverless-practice-app/${STAGE}/${name}`,
    }),
  );
  if (Parameter?.Value === undefined) {
    throw new Error(`SSM パラメータ ${name} に値がありません`);
  }
  return Parameter.Value;
}

/**
 * デプロイ済みのリソースを引く。名前は SSM（Terraform の出力）とステートマシン名の命名規約から得る。
 * 見つからなければ IT を始めずに失敗させる（未デプロイを「検査して 0 件」と区別するため）。
 *
 * @returns デプロイ済みのリソース
 * @throws {Error} LocalStack が起動していない、またはデプロイされていない場合
 */
export async function resolveResources(): Promise<DeployedResources> {
  try {
    const { stateMachines = [] } = await sfn.send(
      new ListStateMachinesCommand({}),
    );
    const stateMachineArn = stateMachines.find(
      (machine) => machine.name === `${PREFIX}-batch`,
    )?.stateMachineArn;
    if (stateMachineArn === undefined) {
      throw new Error(`ステートマシン ${PREFIX}-batch がありません`);
    }

    const dlqName = (await ssmValue("dlq/arn")).split(":").at(-1);
    const { QueueUrl: dlqUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: dlqName }),
    );
    if (dlqUrl === undefined) {
      throw new Error(`DLQ ${String(dlqName)} の URL を引けません`);
    }

    const { EventSourceMappings = [] } = await lambda.send(
      new ListEventSourceMappingsCommand({
        FunctionName: `${PREFIX}-consumer`,
      }),
    );
    // Consumer のイベントソースはキュー 1 つだけ。複数あるならどれを止めればよいか決められない
    const [mapping, ...rest] = EventSourceMappings;
    if (mapping?.UUID === undefined || rest.length > 0) {
      throw new Error(
        `Consumer のイベントソースマッピングが 1 つではありません（${EventSourceMappings.length} 件）`,
      );
    }

    return {
      stateMachineArn,
      bucketName: await ssmValue("bucket/name"),
      queueUrl: await ssmValue("queue/url"),
      dlqUrl,
      consumerEventSourceUuid: mapping.UUID,
    };
  } catch (error) {
    throw new Error(
      "IT の前提（LocalStack の起動とデプロイ）が整っていません。" +
        "scripts/localstack.sh up → scripts/stack.sh local up を先に実行してください",
      { cause: error },
    );
  }
}

/**
 * 実行を起動し、終わるまで待つ。
 *
 * @param stateMachineArn - ステートマシンの ARN
 * @param name - 実行名（IT の中で一意にする）
 * @param input - 実行入力
 * @returns 終わった実行の情報（状態・エラー名・実行 ARN）
 * @throws {Error} 待っても終わらなかった場合
 */
export async function runExecution(
  stateMachineArn: string,
  name: string,
  input: Record<string, unknown>,
): Promise<DescribeExecutionCommandOutput> {
  const { executionArn } = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn,
      name,
      input: JSON.stringify(input),
    }),
  );
  return waitUntilFinished(executionArn);
}

/**
 * 実行を起動し、すぐに止める。止まるまで待つ。
 * 止める前に終わったステップ（キューへの投入など）は取り消されない。
 *
 * @param stateMachineArn - ステートマシンの ARN
 * @param name - 実行名（IT の中で一意にする）
 * @returns 止まった実行の情報（状態・実行 ARN）
 * @throws {Error} 待っても止まらなかった場合
 */
export async function abortExecution(
  stateMachineArn: string,
  name: string,
): Promise<DescribeExecutionCommandOutput> {
  const { executionArn } = await sfn.send(
    new StartExecutionCommand({ stateMachineArn, name, input: "{}" }),
  );
  await sfn.send(new StopExecutionCommand({ executionArn }));
  return waitUntilFinished(executionArn);
}

/**
 * 実行が終わる（RUNNING でなくなる）まで待つ。
 *
 * @param executionArn - 実行 ARN
 * @returns 終わった実行の情報
 * @throws {Error} 待っても終わらなかった場合
 */
function waitUntilFinished(
  executionArn: string | undefined,
): Promise<DescribeExecutionCommandOutput> {
  return pollUntil(
    () => sfn.send(new DescribeExecutionCommand({ executionArn })),
    (execution) => execution.status !== "RUNNING",
    120_000,
  );
}

/**
 * Lambda のログから、指定した実行名・スタブの構造化ログを集める。
 * 前回の実行のログも残っているため、必ず実行名で絞り込む。
 *
 * @param fn - どの Lambda のログか
 * @param executionName - 実行名
 * @param stub - スタブの種類（docs/07「スタブへの出力」の `stub`）
 * @returns 該当するログ（0 件なら空配列）
 */
export async function findStubLogs(
  fn: FunctionName,
  executionName: string,
  stub: string,
): Promise<StubLog[]> {
  const found: StubLog[] = [];
  let nextToken: string | undefined;
  do {
    // filterPattern の対応は LocalStack と AWS で差があるため、全件を取って手元で絞り込む
    const page: FilterLogEventsCommandOutput = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: `/aws/lambda/${PREFIX}-${fn}`,
        nextToken,
      }),
    );
    for (const event of page.events ?? []) {
      const log = parseStubLog(event.message);
      if (log?.stub === stub && log.executionName === executionName) {
        found.push(log);
      }
    }
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return found;
}

/**
 * ログの 1 行をスタブの構造化ログとして読む。
 *
 * @param message - ログの 1 行
 * @returns スタブのログ。JSON でない行（Lambda ランタイムの START / END 等）や、スタブ以外のログは `undefined`
 */
function parseStubLog(message: string | undefined): StubLog | undefined {
  if (message === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(message);
    if (
      typeof value === "object" &&
      value !== null &&
      "stub" in value &&
      typeof value.stub === "string" &&
      "executionName" in value &&
      typeof value.executionName === "string"
    ) {
      return { ...value, stub: value.stub, executionName: value.executionName };
    }
  } catch {
    // JSON でない行はスタブのログではない
  }
  return undefined;
}

/**
 * データ連携の出力先から、指定した実行の連携ファイルのキーを探す。
 * キーの日付は UTC のため、手元の時刻から組み立てず、実行名で探す（docs/05「連携ファイル」）。
 *
 * @param bucketName - バケット名
 * @param executionName - 実行名
 * @returns 見つかったキー（0 件なら空配列）
 */
export async function findExportKeys(
  bucketName: string,
  executionName: string,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: "exports/",
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.endsWith(`/${executionName}.json`) === true) {
        keys.push(object.Key);
      }
    }
    token = page.NextContinuationToken;
  } while (token !== undefined);
  return keys;
}

/**
 * キューを空にする。前回の実行（中断した IT・手動実行）が残したメッセージは、FIFO の同じグループの
 * 後続（今回の実行のメッセージ）を止めてしまうため、IT の開始時に消す。LocalStack 専用の操作
 *
 * @param queueUrl - キューの URL
 * @returns 消し終えたら解決する
 */
export async function purgeQueue(queueUrl: string): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
}

/**
 * イベントソースマッピングを有効・無効にし、切り替わるまで待つ。
 * 切り替えは非同期で、API が返った時点ではまだ Consumer がメッセージを受け取りうるため、状態を見て待つ。
 *
 * @param uuid - イベントソースマッピングの UUID
 * @param enabled - 有効にするなら true
 * @returns 切り替わったら解決する
 * @throws {Error} 待っても切り替わらなかった場合
 */
export async function setEventSourceEnabled(
  uuid: string,
  enabled: boolean,
): Promise<void> {
  await lambda.send(
    new UpdateEventSourceMappingCommand({ UUID: uuid, Enabled: enabled }),
  );
  const expected = enabled ? "Enabled" : "Disabled";
  await pollUntil(
    async () =>
      (await lambda.send(new GetEventSourceMappingCommand({ UUID: uuid })))
        .State,
    (state) => state === expected,
    60_000,
    1_000,
  );
}

/**
 * デプロイ済みのステートマシンの定義を読む。
 *
 * @param stateMachineArn - ステートマシンの ARN
 * @returns 定義
 * @throws {Error} 定義が読めない、または ASL の形でない場合
 */
async function describeDefinition(
  stateMachineArn: string,
): Promise<Definition> {
  const { definition } = await sfn.send(
    new DescribeStateMachineCommand({ stateMachineArn }),
  );
  return definitionSchema.parse(JSON.parse(definition ?? "null"));
}

/**
 * 実行がすぐ TIMED_OUT になるよう、デプロイ済みのステートマシンの定義を書き換える。
 * 先頭に Wait ステートを足し、実行全体のタイムアウトをその待ち時間より短くする。
 * 実行は Wait の途中で終わり、Lambda は呼ばれない。ARN は変わらないため、本番と同じ EventBridge rule を通る。
 * 終わったら必ず {@link restoreExecutionTimeout} で戻す。
 *
 * @param stateMachineArn - ステートマシンの ARN
 * @returns 書き換えたら解決する
 * @throws {Error} 既に書き換わっている場合（元の値を上書きして戻せなくなるため）
 */
export async function shortenExecutionTimeout(
  stateMachineArn: string,
): Promise<void> {
  const original = await describeDefinition(stateMachineArn);
  if (TIMEOUT_WAIT_STATE in original.States) {
    throw new Error(
      `定義に ${TIMEOUT_WAIT_STATE} が残っています。restoreExecutionTimeout で戻してから書き換えてください`,
    );
  }
  const backup: z.infer<typeof timeoutBackupSchema> = {
    TimeoutSeconds: original.TimeoutSeconds ?? null,
  };
  const shortened: Definition = {
    ...original,
    StartAt: TIMEOUT_WAIT_STATE,
    TimeoutSeconds: SHORTENED_TIMEOUT_SECONDS,
    States: {
      ...original.States,
      [TIMEOUT_WAIT_STATE]: {
        Type: "Wait",
        Seconds: TIMEOUT_WAIT_SECONDS,
        Next: original.StartAt,
        Comment: JSON.stringify(backup),
      },
    },
  };
  await sfn.send(
    new UpdateStateMachineCommand({
      stateMachineArn,
      definition: JSON.stringify(shortened),
    }),
  );
}

/**
 * {@link shortenExecutionTimeout} の書き換えを戻す。書き換わっていなければ何もしない。
 * 元の開始ステートは Wait ステートの Next から、元のタイムアウトは Comment から取る。
 * CDK のテンプレートは変わっていないため、再デプロイでは戻らない（変更なしで終わる）
 *
 * @param stateMachineArn - ステートマシンの ARN
 * @returns 戻したら（書き換わっていなければすぐに）解決する
 * @throws {Error} Wait ステートが想定した形でない場合（何を戻せばよいか決められないため）
 */
export async function restoreExecutionTimeout(
  stateMachineArn: string,
): Promise<void> {
  const current = await describeDefinition(stateMachineArn);
  const { [TIMEOUT_WAIT_STATE]: waitState, ...states } = current.States;
  if (waitState === undefined) {
    return;
  }
  const { Next: startAt, Comment: comment } = z
    .object({ Next: z.string(), Comment: z.string() })
    .parse(waitState);
  const backup = timeoutBackupSchema.parse(JSON.parse(comment));
  const { TimeoutSeconds: _shortened, ...rest } = current;
  const restored: Definition = {
    ...rest,
    StartAt: startAt,
    States: states,
    ...(backup.TimeoutSeconds === null
      ? {}
      : { TimeoutSeconds: backup.TimeoutSeconds }),
  };
  await sfn.send(
    new UpdateStateMachineCommand({
      stateMachineArn,
      definition: JSON.stringify(restored),
    }),
  );
}

/**
 * `DataSync` の Comment を、IT が残した元の値として読む。
 *
 * @param comment - `DataSync` の Comment
 * @returns 元の値。IT が書き換えた印が無ければ `undefined`
 */
function parseHeartbeatBackup(
  comment: string | undefined,
): z.infer<typeof heartbeatBackupSchema>["itHeartbeatBackup"] | undefined {
  if (comment === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(comment);
  } catch {
    // JSON でない Comment は元の定義のもので、IT の印ではない
    return undefined;
  }
  const result = heartbeatBackupSchema.safeParse(parsed);
  return result.success ? result.data.itHeartbeatBackup : undefined;
}

/**
 * `DataSync` のハートビートがすぐ切れるよう、デプロイ済みのステートマシンの定義を書き換える。
 * 本番のハートビート（300 秒）を待たずに、結果もハートビートも返さない関数の扱いを確かめるため。
 * ARN は変わらないため、本番と同じ EventBridge rule を通る。終わったら必ず {@link restoreDataSyncHeartbeat} で戻す。
 *
 * @param stateMachineArn - ステートマシンの ARN
 * @returns 書き換えたら解決する
 * @throws {Error} `DataSync` が無い・ハートビートを持たない、または既に書き換わっている場合（元の値を上書きして戻せなくなるため）
 */
export async function shortenDataSyncHeartbeat(
  stateMachineArn: string,
): Promise<void> {
  const original = await describeDefinition(stateMachineArn);
  const state = taskStateSchema.parse(original.States[DATA_SYNC_STATE]);
  if (parseHeartbeatBackup(state.Comment) !== undefined) {
    throw new Error(
      `${DATA_SYNC_STATE} が書き換わったままです。restoreDataSyncHeartbeat で戻してから書き換えてください`,
    );
  }
  if (state.HeartbeatSeconds === undefined) {
    throw new Error(`${DATA_SYNC_STATE} にハートビートが設定されていません`);
  }
  const backup: z.infer<typeof heartbeatBackupSchema> = {
    itHeartbeatBackup: {
      HeartbeatSeconds: state.HeartbeatSeconds,
      Comment: state.Comment ?? null,
    },
  };
  const shortened: Definition = {
    ...original,
    States: {
      ...original.States,
      [DATA_SYNC_STATE]: {
        ...state,
        HeartbeatSeconds: SHORTENED_HEARTBEAT_SECONDS,
        Comment: JSON.stringify(backup),
      },
    },
  };
  await sfn.send(
    new UpdateStateMachineCommand({
      stateMachineArn,
      definition: JSON.stringify(shortened),
    }),
  );
}

/**
 * {@link shortenDataSyncHeartbeat} の書き換えを戻す。書き換わっていなければ何もしない。
 * 元のハートビートと Comment は、書き換えた `DataSync` の Comment から取る。
 * CDK のテンプレートは変わっていないため、再デプロイでは戻らない（変更なしで終わる）
 *
 * @param stateMachineArn - ステートマシンの ARN
 * @returns 戻したら（書き換わっていなければすぐに）解決する
 */
export async function restoreDataSyncHeartbeat(
  stateMachineArn: string,
): Promise<void> {
  const current = await describeDefinition(stateMachineArn);
  const state = taskStateSchema.parse(current.States[DATA_SYNC_STATE]);
  const backup = parseHeartbeatBackup(state.Comment);
  if (backup === undefined) {
    return;
  }
  const { Comment: _marker, ...rest } = state;
  const restored: Definition = {
    ...current,
    States: {
      ...current.States,
      [DATA_SYNC_STATE]: {
        ...rest,
        HeartbeatSeconds: backup.HeartbeatSeconds,
        ...(backup.Comment === null ? {} : { Comment: backup.Comment }),
      },
    },
  };
  await sfn.send(
    new UpdateStateMachineCommand({
      stateMachineArn,
      definition: JSON.stringify(restored),
    }),
  );
}

/** 実行履歴の `TaskTimedOut` イベントのうち、IT が読む項目 */
export type TaskTimedOutEvent = {
  /** タイムアウトしたタスクのリソースの種類（例: `lambda`） */
  resourceType: string | undefined;
  /** タイムアウトのエラー名。どの名前で出るかを確かめるのが目的のため、値を加工しない */
  error: string | undefined;
};

/**
 * 実行履歴から `TaskTimedOut` イベントを集める（`GetExecutionHistory` の `taskTimedOutEventDetails`）。
 *
 * @param executionArn - 実行 ARN
 * @returns `TaskTimedOut` イベント（0 件なら空配列）
 */
export async function findTaskTimedOutEvents(
  executionArn: string | undefined,
): Promise<TaskTimedOutEvent[]> {
  const events = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(
      new GetExecutionHistoryCommand({ executionArn, nextToken }),
    );
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return events
    .filter((event) => event.type === "TaskTimedOut")
    .map((event) => ({
      resourceType: event.taskTimedOutEventDetails?.resourceType,
      error: event.taskTimedOutEventDetails?.error,
    }));
}

/**
 * キューから、指定した実行のメッセージの配信対象 ID を受け取る。メッセージは消さない。
 *
 * @param queueUrl - キュー（DLQ を含む）の URL
 * @param executionName - 実行名
 * @returns 受け取ったメッセージの配信対象 ID（0 件なら空配列）
 */
export async function receiveRecipientIds(
  queueUrl: string,
  executionName: string,
): Promise<string[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      // 短いポーリングは一部のサーバーしか見ず、メッセージがあっても 0 件を返しうる。
      // 「無い」ことの確認にも使うため、ロングポーリングにする
      WaitTimeSeconds: 1,
      // 受け取ったメッセージをすぐ見える状態に戻し、次のポーリングでも同じものを受け取れるようにする
      VisibilityTimeout: 0,
    }),
  );
  return Messages.flatMap((message) => {
    const body: unknown = JSON.parse(message.Body ?? "null");
    return typeof body === "object" &&
      body !== null &&
      "executionName" in body &&
      body.executionName === executionName &&
      "recipientId" in body &&
      typeof body.recipientId === "string"
      ? [body.recipientId]
      : [];
  });
}
