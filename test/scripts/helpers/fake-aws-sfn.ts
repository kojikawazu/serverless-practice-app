// scripts/batch.sh のテストで、PATH の先頭に置く偽の AWS CLI（test/scripts/batch.test.ts）。
// batch.sh が呼ぶ Step Functions の 3 つの操作だけを、スクリプトが渡す --query の形に合わせて返す。
// 実行の結果（状態・エラー）を思いどおりに作るため、LocalStack ではなく外部 I/O（AWS CLI）だけをこれに差し替える（.claude/rules/testing.md）。
// Node の型除去（--experimental-strip-types）でそのまま動かすため、型の注釈以外の TypeScript 固有の構文を使わない。
//
// 環境変数:
//   FAKE_AWS_STATE   状態を持つ JSON ファイル。呼び出しのたびに読み書きする
//   FAKE_AWS_LOG     呼び出しを 1 行 1 JSON で追記するファイル
//
// 状態の JSON は `JSON.parse(...) as 型` で読み、検証しない。書くのはテストだけで、形が違えばテストが落ちて分かるため（fake-aws.ts と同じ）。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** 偽の Step Functions が持つ状態。テストが初期状態を書き、呼び出しの後に読んで確かめる */
export type FakeSfnState = {
  /** デプロイ済みのステートマシン */
  stateMachines: { name: string; stateMachineArn: string }[];
  /**
   * describe-execution が返す状態の列。呼ばれるたびに 1 つ進み、末尾に着いたら末尾の値を返し続ける。
   * `["RUNNING"]` なら終わらない実行になる
   */
  statuses: string[];
  /** 終わった実行の `error`。`undefined` なら項目ごと返さない（実 AWS の `SUCCEEDED` と同じ） */
  error?: string;
  /** 終わった実行の `cause`。`undefined` なら項目ごと返さない */
  cause?: string;
  /** describe-execution が呼ばれた回数。偽物が書く */
  describeCount: number;
  /** start-execution で受け取った実行名と入力（入力は文字列のまま）。偽物が書き、未起動なら `null` */
  started: { name: string; input: string } | null;
  /** 操作名（`list-state-machines` など）ごとに、返すエラーコード。認証切れなどを再現する */
  failOn?: Record<string, string>;
};

const statePath = process.env["FAKE_AWS_STATE"];
const logPath = process.env["FAKE_AWS_LOG"];
if (statePath === undefined || logPath === undefined) {
  process.stderr.write(
    "fake-aws-sfn: FAKE_AWS_STATE と FAKE_AWS_LOG が要ります\n",
  );
  process.exit(255);
}

const args = process.argv.slice(2);
appendFileSync(logPath, `${JSON.stringify(args)}\n`);

// --name value の組と、それ以外（サービス名・操作名）に分ける
const options: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] ?? "";
  if (arg.startsWith("--")) {
    options[arg.slice(2)] = args[i + 1] ?? "";
    i += 1;
  } else {
    positional.push(arg);
  }
}
const [service, operation] = positional;
const state = JSON.parse(readFileSync(statePath, "utf8")) as FakeSfnState;

const EXECUTION_ARN_PREFIX =
  "arn:aws:states:ap-northeast-1:123456789012:execution";

/**
 * AWS CLI と同じ形のエラーを出して終える。
 *
 * @param code - エラーコード
 * @param message - メッセージ
 */
function fail(code: string, message: string): never {
  process.stderr.write(
    `\nAn error occurred (${code}) when calling the ${operation ?? ""} operation: ${message}\n`,
  );
  process.exit(254);
}

/**
 * 状態を保存し、`--output text` の応答を出して終える。
 *
 * @param text - 標準出力に出す文字列
 */
function replyText(text: string): never {
  writeFileSync(statePath ?? "", JSON.stringify(state));
  process.stdout.write(`${text}\n`);
  process.exit(0);
}

if (operation !== undefined && state.failOn?.[operation] !== undefined) {
  fail(state.failOn[operation], "injected by the test");
}

switch (`${service ?? ""} ${operation ?? ""}`) {
  case "stepfunctions list-state-machines": {
    // batch.sh の --query は stateMachines[?name=='<名前>'].stateMachineArn | [0]。名前だけを取り出して同じ結果を返す
    const wanted = /name=='([^']+)'/.exec(options["query"] ?? "")?.[1];
    const found = state.stateMachines.find((m) => m.name === wanted);
    // AWS CLI の --output text は、JMESPath の結果が null なら "None" を出す
    replyText(found?.stateMachineArn ?? "None");
    break;
  }
  case "stepfunctions start-execution": {
    const name = options["name"] ?? "";
    state.started = { name, input: options["input"] ?? "" };
    replyText(`${EXECUTION_ARN_PREFIX}:batch:${name}`);
    break;
  }
  case "stepfunctions describe-execution": {
    const index = Math.min(state.describeCount, state.statuses.length - 1);
    const status = state.statuses[index] ?? "RUNNING";
    state.describeCount += 1;
    if (options["query"] === "status") {
      replyText(status);
    }
    replyText(
      JSON.stringify({
        executionArn: options["execution-arn"],
        status,
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(state.cause === undefined ? {} : { cause: state.cause }),
      }),
    );
    break;
  }
  default:
    fail(
      "FakeAwsUnsupported",
      `fake-aws-sfn は ${args.join(" ")} に対応していません`,
    );
}
