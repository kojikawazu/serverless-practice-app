import { beforeAll, describe, expect, it } from "vitest";
import { MySqlStub } from "../../functions/src/stubs/mysql-stub";
import {
  abortExecution,
  findExportKeys,
  findSkippedMessageKeys,
  findStubLogs,
  findStubLogsByRunKey,
  findTaskTimedOutEvents,
  pollUntil,
  purgeQueue,
  readExportFile,
  receiveRecipientIds,
  rerunWithScript,
  resolveResources,
  restoreDataSyncHeartbeat,
  restoreExecutionTimeout,
  runExecution,
  setEventSourceEnabled,
  shortenDataSyncHeartbeat,
  shortenExecutionTimeout,
  sleep,
} from "./helpers/localstack";
import type { DeployedResources } from "./helpers/localstack";

// docs/02「受け入れ条件」のうち local で確かめられるものを、デプロイ済みの LocalStack で確かめる（docs/08 #20〜#22・#25〜#27・#32・#54・#80・#91・#92）。
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

/** 送った直後の失敗の後、再配信で送信済みとして飛ばすまで待つ最大時間（ミリ秒）。可視性タイムアウト 60 秒に余裕を足す（docs/04「リトライ」） */
const REDELIVERY_TIMEOUT_MS = 180_000;

/**
 * SQS FIFO の重複排除の期間（ミリ秒）。#92 は、再実行がこの期間の内に起動したことを確かめる。
 * 期間を過ぎてから再実行すると、重複排除 ID を引き継いでいても捨てられないため、引き継がない理由を確かめたことにならない（docs/05「メールメッセージ」）
 */
const DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000;

/** IT の 1 回の実行を区別する接頭辞。前回の IT や手動実行のログ・ファイルと混ざらないよう、確認はすべて実行名で絞り込む */
const RUN_ID = `it-${Date.now().toString(36)}`;

let resources: DeployedResources;
let recipientIds: string[];

/** consumer のケースの実行名。その再実行のケース（#92）が引き継ぐ */
const CONSUMER_CASE_NAME = `${RUN_ID}-consumer`;

/** consumer のケースの実行が始まった時刻。再実行が重複排除の期間の内かを確かめるために、次のケースが読む */
let consumerCaseStartedAt: Date | undefined;

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
  // 同じく、ハートビートのケースの途中で止まると、以後の holdSeconds 付きの実行がハートビート切れで落ちるため戻す
  await restoreDataSyncHeartbeat(resources.stateMachineArn);
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

  it("holdSeconds: 61: データ連携がハートビートを送りながら 61 秒待ってから結果を返し、SUCCEEDED になる", async () => {
    const name = `${RUN_ID}-hold`;
    // 60 秒ごとにハートビートを送るため、61 秒なら 0 秒と 60 秒の 2 回送る（docs/09「LMI（Lambda Managed Instances）」）
    const holdSeconds = 61;

    const execution = await runExecution(resources.stateMachineArn, name, {
      holdSeconds,
    });

    expect(execution.status).toBe("SUCCEEDED");
    const elapsedMs =
      (execution.stopDate?.getTime() ?? 0) -
      (execution.startDate?.getTime() ?? 0);
    expect(elapsedMs).toBeGreaterThanOrEqual(holdSeconds * 1000);
    expect(await findExportKeys(resources.bucketName, name)).toHaveLength(1);
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
    // タイムアウトした実行は error / cause を持たない。実 AWS でも同じ（docs/09「`dev` での検証結果」）
    expect(await waitForSlackLogs(name)).toEqual([
      expect.objectContaining({
        executionArn: execution.executionArn,
        status: "TIMED_OUT",
        error: null,
        cause: null,
      }),
    ]);
  });

  it("データ連携が結果もハートビートも返さない: DataSync が States.Timeout で失敗して FAILED になり、Slack スタブに出る", async () => {
    const name = `${RUN_ID}-heartbeat`;
    // 本番のハートビート（300 秒）を待たずに切らすため、この実行の間だけ DataSync のハートビートを 2 秒にする。
    // holdSeconds（10 秒）の間、関数は最初の 1 回しかハートビートを送らないため、結果を返す前に切れる
    await shortenDataSyncHeartbeat(resources.stateMachineArn);
    let execution;
    try {
      execution = await runExecution(resources.stateMachineArn, name, {
        holdSeconds: 10,
      });
    } finally {
      await restoreDataSyncHeartbeat(resources.stateMachineArn);
    }

    // エラー名は LocalStack で観測した値（実 AWS は未観測。docs/09「LocalStack での検証結果」）。
    // States.HeartbeatTimeout ではない。タスクのタイムアウト（960 秒）はこの IT の待ちより長いため、
    // FAILED になったのはハートビートが切れたから（定義を書き換えない同じ入力は SUCCEEDED になる。08 #35 と同じ流れ）
    expect(execution.status).toBe("FAILED");
    expect(execution.error).toBe("States.Timeout");
    expect(await findTaskTimedOutEvents(execution.executionArn)).toEqual([
      { resourceType: "lambda", error: "States.Timeout" },
    ]);
    expect(await waitForSlackLogs(name)).toEqual([
      expect.objectContaining({
        executionArn: execution.executionArn,
        status: "FAILED",
        error: "States.Timeout",
        cause: null,
      }),
    ]);
  });

  it('failAt: "dataSync" の実行を rerun で再実行する: SUCCEEDED になり、メールは元の実行の 1 通ずつだけで、S3 の同じキーに上書きし、BigQuery・Cuenote FC へ runKey 付きで書く（#137）', async () => {
    const name = `${RUN_ID}-rerun-datasync`;
    const original = await runExecution(resources.stateMachineArn, name, {
      failAt: "dataSync",
    });
    expect(original.status).toBe("FAILED");
    // 元の実行のメールが送り終わるのを待ってから再実行する（再実行の判定の前提を作る）
    await pollUntil(
      () => findStubLogs("consumer", name, "sendgrid"),
      (found) => found.length >= recipientIds.length,
      LOG_TIMEOUT_MS,
    );

    const rerun = await rerunWithScript(resources.stateMachineArn, name);

    expect(rerun.status).toBe("SUCCEEDED");
    expect(JSON.parse(rerun.input ?? "")).toEqual({ rerunOf: name });
    // 再実行は配信対象ごとに「送信済みのため送りません」を出し、送らない
    const skipped = await pollUntil(
      () => findSkippedMessageKeys(name),
      (keys) => keys.length >= recipientIds.length,
      LOG_TIMEOUT_MS,
    );
    expect(skipped.sort()).toEqual(recipientIds.map((id) => `${name}:${id}`));
    await sleep(ABSENCE_GRACE_MS);
    const sent = await findStubLogsByRunKey("consumer", name, "sendgrid");
    expect(
      sent.map((log) => [log.executionName, log.recipientId]).sort(),
    ).toEqual(recipientIds.map((id) => [name, id]));
    // 連携ファイルは同じキーの 1 つだけで、中身は再実行が書いたもの
    const keys = await findExportKeys(resources.bucketName, name);
    expect(keys).toHaveLength(1);
    expect(
      await readExportFile(resources.bucketName, keys[0] ?? ""),
    ).toMatchObject({
      executionName: rerun.name,
      runKey: name,
    });
    for (const stub of ["bigquery", "cuenote-fc"]) {
      expect(await findStubLogsByRunKey("data-sync", name, stub)).toEqual([
        expect.objectContaining({ executionName: rerun.name, runKey: name }),
      ]);
    }
  }, 300_000);

  // 再配信まで可視性タイムアウトの間グループが止まるため、他のケースの後・consumer のケースの前に置く
  it('failAt: "consumerAfterSend": SUCCEEDED になり、送った直後の失敗で再配信されても、メールは配信対象ごとに 1 通だけ送られる（#136）', async () => {
    const name = `${RUN_ID}-after-send`;

    const execution = await runExecution(resources.stateMachineArn, name, {
      failAt: "consumerAfterSend",
    });

    expect(execution.status).toBe("SUCCEEDED");
    // 1 回目の受信で送って送信済みを記録してから失敗し、可視性タイムアウトの後の再配信で、送らずに成功する
    const skipped = await pollUntil(
      () => findSkippedMessageKeys(name),
      (keys) => keys.length >= recipientIds.length,
      REDELIVERY_TIMEOUT_MS,
      10_000,
    );
    expect(skipped.sort()).toEqual(recipientIds.map((id) => `${name}:${id}`));
    await sleep(ABSENCE_GRACE_MS);
    const sent = await findStubLogs("consumer", name, "sendgrid");
    expect(sent.map((log) => log.recipientId).sort()).toEqual(recipientIds);
    expect(await receiveRecipientIds(resources.dlqUrl, name)).toEqual([]);
  }, 300_000);

  // 他のケースのメッセージを巻き込まないよう最後に置く（ファイル先頭のコメント）
  it('failAt: "consumer": SUCCEEDED のまま、配信対象の件数のメッセージが DLQ へ移り、実行の失敗としては Slack スタブに出ない', async () => {
    const name = CONSUMER_CASE_NAME;

    const execution = await runExecution(resources.stateMachineArn, name, {
      failAt: "consumer",
    });
    consumerCaseStartedAt = execution.startDate;

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
    // DLQ へ移るまでの数分で通知が出ていれば届いている。実行は SUCCEEDED のため、状態変化イベントの通知は出ない。
    // Consumer の失敗は DLQ のアラームで通知されるが、その通知は実行名を持たないため、この絞り込みには入らない。
    // LocalStack はアラームの状態変化を EventBridge に出さないため、アラームの通知は IT では確かめない（docs/02「F-5」・#135）
    expect(await findStubLogs("notify-slack", name, "slack")).toEqual([]);
    expect(await findStubLogs("consumer", name, "sendgrid")).toEqual([]);
  }, 420_000);

  // 直前の consumer のケースの続き。DLQ へ移った直後に再実行し、重複排除の期間（5 分）の内に起動する
  it('failAt: "consumer" の実行を、DLQ へ移った後に rerun で再実行する: 元の実行から 5 分以内でも、メールが配信対象ごとに 1 通送られる（#137）', async () => {
    const name = CONSUMER_CASE_NAME;
    if (consumerCaseStartedAt === undefined) {
      throw new Error(
        "前のケース（failAt: consumer）が実行を起動していないため、再実行を確かめられません",
      );
    }

    const rerun = await rerunWithScript(resources.stateMachineArn, name);

    expect(rerun.status).toBe("SUCCEEDED");
    // 期間を過ぎてから起動していたら、重複排除 ID を引き継がない理由を確かめたことにならないため失敗にする
    expect(
      (rerun.startDate?.getTime() ?? Infinity) -
        consumerCaseStartedAt.getTime(),
    ).toBeLessThan(DEDUPLICATION_WINDOW_MS);
    await pollUntil(
      () => findStubLogsByRunKey("consumer", name, "sendgrid"),
      (found) => found.length >= recipientIds.length,
      LOG_TIMEOUT_MS,
    );
    await sleep(ABSENCE_GRACE_MS);
    expect(
      (await findStubLogsByRunKey("consumer", name, "sendgrid"))
        .map((log) => [log.executionName, log.recipientId])
        .sort(),
    ).toEqual(recipientIds.map((id) => [rerun.name, id]));
  }, 420_000);
});
