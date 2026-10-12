import { beforeAll, describe, expect, it } from "vitest";
import { MySqlStub } from "../../functions/src/stubs/mysql-stub";
import {
  abortExecution,
  findExportKeys,
  findStubLogs,
  pollUntil,
  purgeQueue,
  receiveRecipientIds,
  resolveResources,
  restoreExecutionTimeout,
  runExecution,
  setEventSourceEnabled,
  shortenExecutionTimeout,
  sleep,
} from "./helpers/localstack";
import type { DeployedResources } from "./helpers/localstack";

// docs/02「受け入れ条件」のうち local で確かめられるものを、デプロイ済みの LocalStack で確かめる（docs/08 #20〜#22・#25〜#27・#32）。
// 前提: scripts/localstack.sh up → scripts/stack.sh local up
//
// ケースは順番に実行する（concurrent を付けない。同じファイルのテストは既定で順番に走る）。
// メッセージグループは配信対象ごとで、どの実行でも同じ。failAt=consumer の失敗し続けるメッセージが
// グループの先頭にあると別の実行の後続メッセージが止まり、Consumer がそれを「同じグループの後続」として
// 失敗扱いにする（docs/03「Consumer Lambda」）。並行に流すと成功するはずのメッセージまで DLQ へ移りうるため、
// consumer のケースは最後に置く（docs/05「メールメッセージ」）。

/** 「出ない」ことを確かめる前に待つ時間（ミリ秒）。先に出るはずのログを確認した後に、遅れて届く分を待つ */
const ABSENCE_GRACE_MS = 10_000;

/** ログが CloudWatch Logs に届くまで待つ最大時間（ミリ秒）。Lambda のコールドスタートを含める */
const LOG_TIMEOUT_MS = 60_000;

/** DLQ へ移るまで待つ最大時間（ミリ秒）。可視性タイムアウト 60 秒 × 受信 3 回に、余裕を足す（docs/04「リトライ」） */
const DLQ_TIMEOUT_MS = 330_000;

/** IT の 1 回の実行を区別する接頭辞。前回の IT や手動実行のログ・ファイルと混ざらないよう、確認はすべて実行名で絞り込む */
const RUN_ID = `it-${Date.now().toString(36)}`;

let resources: DeployedResources;
let recipientIds: string[];

beforeAll(async () => {
  resources = await resolveResources();
  // 配信対象はスタブの固定データから取る（件数・ID をテストに書き写さない）
  recipientIds = (await new MySqlStub().findAll())
    .map((recipient) => recipient.recipientId)
    .sort();
  // 前回の IT が enqueue のケースの途中で止まると、Consumer が止まったまま残るため戻す
  await setEventSourceEnabled(resources.consumerEventSourceUuid, true);
  // 前回の IT が TIMED_OUT のケースの途中で止まると、定義が書き換わったまま残り、以後の実行がすべて TIMED_OUT になるため戻す
  await restoreExecutionTimeout(resources.stateMachineArn);
  // 前回の中断した IT・手動実行が残したメッセージは、同じグループの今回のメッセージを止めるため消す
  await purgeQueue(resources.queueUrl);
  await purgeQueue(resources.dlqUrl);
});

/**
 * Slack スタブのログが 1 件出るまで待つ。
 *
 * @param executionName - 実行名
 * @returns Slack スタブのログ
 */
function waitForSlackLogs(executionName: string) {
  return pollUntil(
    () => findStubLogs("notify-slack", executionName, "slack"),
    (found) => found.length > 0,
    LOG_TIMEOUT_MS,
  );
}

describe("バッチの実行（LocalStack）", () => {
  it("failAt なし: SUCCEEDED になり、配信対象の件数だけメールを送り、S3・BigQuery・Cuenote FC へ書き出す", async () => {
    const name = `${RUN_ID}-ok`;

    const execution = await runExecution(resources.stateMachineArn, name, {});

    expect(execution.status).toBe("SUCCEEDED");
    const mails = await pollUntil(
      () => findStubLogs("consumer", name, "sendgrid"),
      (found) => found.length >= recipientIds.length,
      LOG_TIMEOUT_MS,
    );
    expect(mails.map((mail) => mail.recipientId).sort()).toEqual(recipientIds);
    expect(await findExportKeys(resources.bucketName, name)).toHaveLength(1);
    for (const stub of ["bigquery", "cuenote-fc"]) {
      const written = await pollUntil(
        () => findStubLogs("data-sync", name, stub),
        (found) => found.length > 0,
        LOG_TIMEOUT_MS,
      );
      expect(written).toEqual([
        expect.objectContaining({ count: recipientIds.length }),
      ]);
    }
  });

  it('failAt: "enqueue": FAILED になり、Slack スタブに実行 ARN と FAILED が出て、キューにも DLQ にもメッセージが積まれない', async () => {
    const name = `${RUN_ID}-enqueue`;
    // Consumer が動いていると、積まれたメッセージは数秒で受け取られて消え、キューを見ても空になる。
    // 積まれたかどうかをキューで確かめるため、このケースの間だけ止める（止めっぱなしは beforeAll で戻す）
    await setEventSourceEnabled(resources.consumerEventSourceUuid, false);
    try {
      const execution = await runExecution(resources.stateMachineArn, name, {
        failAt: "enqueue",
      });

      expect(execution).toMatchObject({
        status: "FAILED",
        error: "InjectedFailureError",
      });
      expect(await waitForSlackLogs(name)).toEqual([
        expect.objectContaining({
          executionArn: execution.executionArn,
          status: "FAILED",
          error: "InjectedFailureError",
        }),
      ]);
      await sleep(ABSENCE_GRACE_MS);
      expect(await receiveRecipientIds(resources.queueUrl, name)).toEqual([]);
      expect(await receiveRecipientIds(resources.dlqUrl, name)).toEqual([]);
    } finally {
      await setEventSourceEnabled(resources.consumerEventSourceUuid, true);
    }
  });

  it('failAt: "dataSync": FAILED になり、S3 にファイルが残り、BigQuery・Cuenote FC へは書かず、Slack スタブに出る', async () => {
    const name = `${RUN_ID}-datasync`;

    const execution = await runExecution(resources.stateMachineArn, name, {
      failAt: "dataSync",
    });

    expect(execution).toMatchObject({
      status: "FAILED",
      error: "InjectedFailureError",
    });
    expect(await findExportKeys(resources.bucketName, name)).toHaveLength(1);
    expect(await waitForSlackLogs(name)).toEqual([
      expect.objectContaining({
        executionArn: execution.executionArn,
        status: "FAILED",
      }),
    ]);
    await sleep(ABSENCE_GRACE_MS);
    expect(await findStubLogs("data-sync", name, "bigquery")).toEqual([]);
    expect(await findStubLogs("data-sync", name, "cuenote-fc")).toEqual([]);
  });

  it("failAt が未定義の値: 検証エラーで FAILED になり、Slack スタブに出る", async () => {
    const name = `${RUN_ID}-invalid`;

    const execution = await runExecution(resources.stateMachineArn, name, {
      failAt: "unknown",
    });

    expect(execution).toMatchObject({
      status: "FAILED",
      error: "ValidationError",
    });
    expect(await waitForSlackLogs(name)).toEqual([
      expect.objectContaining({
        executionArn: execution.executionArn,
        status: "FAILED",
        error: "ValidationError",
      }),
    ]);
  });

  it("実行を止める: ABORTED になり、Slack スタブに実行 ARN と ABORTED が出る", async () => {
    const name = `${RUN_ID}-abort`;

    const execution = await abortExecution(resources.stateMachineArn, name);

    expect(execution.status).toBe("ABORTED");
    // 止めた実行は error / cause を持たない（docs/07「状態変化イベント」）
    expect(await waitForSlackLogs(name)).toEqual([
      expect.objectContaining({
        executionArn: execution.executionArn,
        status: "ABORTED",
        error: null,
        cause: null,
      }),
    ]);
  });

  it("実行全体のタイムアウトを越える: TIMED_OUT になり、Slack スタブに実行 ARN と TIMED_OUT が出る", async () => {
    const name = `${RUN_ID}-timeout`;
    // 本番のタイムアウト（5 分）を待たずに TIMED_OUT を起こすため、この実行の間だけ定義を書き換える
    await shortenExecutionTimeout(resources.stateMachineArn);
    let execution;
    try {
      execution = await runExecution(resources.stateMachineArn, name, {});
    } finally {
      await restoreExecutionTimeout(resources.stateMachineArn);
    }

    expect(execution.status).toBe("TIMED_OUT");
    // error / cause は確かめない。LocalStack では null だが、実 AWS の値は観測していない（docs/09「LocalStack での検証結果」）
    expect(await waitForSlackLogs(name)).toEqual([
      expect.objectContaining({
        executionArn: execution.executionArn,
        status: "TIMED_OUT",
      }),
    ]);
  });

  // 他のケースのメッセージを巻き込まないよう最後に置く（ファイル先頭のコメント）
  it('failAt: "consumer": SUCCEEDED のまま、配信対象の件数のメッセージが DLQ へ移り、Slack スタブには出ない', async () => {
    const name = `${RUN_ID}-consumer`;

    const execution = await runExecution(resources.stateMachineArn, name, {
      failAt: "consumer",
    });

    expect(execution.status).toBe("SUCCEEDED");
    const inDlq = new Set<string>();
    await pollUntil(
      async () => {
        for (const id of await receiveRecipientIds(resources.dlqUrl, name)) {
          inDlq.add(id);
        }
        return inDlq.size;
      },
      (size) => size >= recipientIds.length,
      DLQ_TIMEOUT_MS,
      10_000,
    );
    expect([...inDlq].sort()).toEqual(recipientIds);
    // DLQ へ移るまでの数分で通知が出ていれば届いている。Consumer の失敗は通知に乗らない（docs/02「F-5」）
    expect(await findStubLogs("notify-slack", name, "slack")).toEqual([]);
    expect(await findStubLogs("consumer", name, "sendgrid")).toEqual([]);
  }, 420_000);
});
