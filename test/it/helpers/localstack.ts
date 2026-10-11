import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { FilterLogEventsCommandOutput } from "@aws-sdk/client-cloudwatch-logs";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  DescribeExecutionCommand,
  ListStateMachinesCommand,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import type { DescribeExecutionCommandOutput } from "@aws-sdk/client-sfn";
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

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
const logs = new CloudWatchLogsClient(CLIENT_CONFIG);
// LocalStack はバケット名のサブドメイン形式を解決できないため、パス形式で接続する
const s3 = new S3Client({ ...CLIENT_CONFIG, forcePathStyle: true });
const sqs = new SQSClient(CLIENT_CONFIG);
const ssm = new SSMClient(CLIENT_CONFIG);

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
};

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

    return {
      stateMachineArn,
      bucketName: await ssmValue("bucket/name"),
      queueUrl: await ssmValue("queue/url"),
      dlqUrl,
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
 * DLQ から、指定した実行のメッセージの配信対象 ID を受け取る。メッセージは消さない。
 *
 * @param dlqUrl - DLQ の URL
 * @param executionName - 実行名
 * @returns 受け取ったメッセージの配信対象 ID（0 件なら空配列）
 */
export async function receiveDlqRecipientIds(
  dlqUrl: string,
  executionName: string,
): Promise<string[]> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
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
