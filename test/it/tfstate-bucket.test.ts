import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { createS3Client } from "./helpers/localstack";

// scripts/tfstate-bucket.sh（state バケットを iac.md の設定にそろえる）を、LocalStack の使い捨てのバケットで確かめる（docs/08 #28〜#31）。
// 前提: scripts/localstack.sh up（デプロイは要らない）。
// 本物の state バケット（LocalStack 内では tflocal が local の state を置いている）は触らないよう、
// TFSTATE_BUCKET で毎回別の名前を渡す。

const SCRIPT = path.resolve(
  import.meta.dirname,
  "../../scripts/tfstate-bucket.sh",
);

/** 他のアカウントとして振る舞うときのアカウント ID（LocalStack はアクセスキーの 12 桁をアカウント ID とみなす） */
const OTHER_ACCOUNT_ID = "222222222222";

/** IT の 1 回の実行を区別する接頭辞。バケット名は全体で一意なため、前回の IT の残りとぶつけない */
const RUN_ID = `it-tfstate-${Date.now().toString(36)}`;

const s3 = createS3Client();
const otherS3 = createS3Client(OTHER_ACCOUNT_ID);

/** 後片付けで消すバケット（作ったアカウントのクライアントと組で持つ） */
const created: { bucket: string; client: typeof s3 }[] = [];

/** スクリプトの実行結果 */
type ScriptResult = {
  /** 終了コード */
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * スクリプトを local ステージで実行する。終了コードが 0 以外でも例外にせず、結果として返す。
 *
 * @param bucket - 対象のバケット名（TFSTATE_BUCKET で渡す）
 * @param args - stage より後ろの引数（`--check` など）
 * @returns 終了コードと出力
 */
async function runScript(
  bucket: string,
  args: string[] = [],
): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      SCRIPT,
      ["local", ...args],
      { env: { ...process.env, TFSTATE_BUCKET: bucket } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    // execFile は終了コードが 0 以外だと、code・stdout・stderr を持つエラーで reject する
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

/**
 * 使い捨てのバケット名を作り、後片付けの対象に入れる。
 *
 * @param suffix - ケースを区別する接尾辞
 * @returns バケット名
 */
function newBucket(suffix: string): string {
  const bucket = `${RUN_ID}-${suffix}`;
  created.push({ bucket, client: s3 });
  return bucket;
}

/**
 * スクリプトでそろえたバケットを用意する。
 *
 * @param suffix - ケースを区別する接尾辞
 * @returns バケット名
 */
async function preparedBucket(suffix: string): Promise<string> {
  const bucket = newBucket(suffix);
  expect((await runScript(bucket)).code).toBe(0);
  return bucket;
}

afterAll(async () => {
  // オブジェクトは置かないため、バケットはそのまま消せる
  for (const { bucket, client } of created) {
    await client
      .send(new DeleteBucketCommand({ Bucket: bucket }))
      .catch(() => undefined);
  }
});

describe("state バケットのスクリプト（LocalStack）", () => {
  it("無いバケットを作って全項目をそろえ、2 回目は何も変えず、--check は 0 で終わる", async () => {
    const bucket = newBucket("new");

    expect((await runScript(bucket, ["--check"])).code).toBe(1);
    const first = await runScript(bucket);
    const second = await runScript(bucket);
    const check = await runScript(bucket, ["--check"]);

    expect(first.code).toBe(0);
    expect(first.stdout.match(/設定しました/g)).toHaveLength(7);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("設定しました");
    expect(second.stdout).toContain("すべての設定がそろっています");
    expect(check.code).toBe(0);
  });

  it("設定を崩すと --check が 1 で崩れた項目を示し、実行するとその項目だけを直す", async () => {
    const bucket = await preparedBucket("drift");
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Suspended" },
      }),
    );
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: "tfstate-retention",
              Status: "Enabled",
              Filter: { Prefix: "" },
              // 新しい版を残す条件だけを外す（直近の履歴まで消える設定）。他の値はあるべき設定と同じにし、
              // 古い版の条件そのものを比べていることを確かめる（他の値の違いで検出されて通らないように）
              NoncurrentVersionExpiration: { NoncurrentDays: 90 },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            },
          ],
        },
      }),
    );
    await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));

    const check = await runScript(bucket, ["--check"]);
    const fix = await runScript(bucket);

    expect(check.code).toBe(1);
    expect(check.stdout.match(/ずれがあります/g)).toHaveLength(3);
    for (const label of [
      "バージョニング",
      "ライフサイクル",
      "バケットポリシー",
    ]) {
      expect(check.stdout).toMatch(new RegExp(`${label}.*: ずれがあります`));
    }
    expect(fix.code).toBe(0);
    expect(fix.stdout.match(/設定しました/g)).toHaveLength(3);
    expect((await runScript(bucket, ["--check"])).code).toBe(0);
  });

  it("他のアカウントが持つ名前のバケットには、何も設定せずに 1 で終わる", async () => {
    const bucket = `${RUN_ID}-other`;
    await otherS3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: { LocationConstraint: "ap-northeast-1" },
      }),
    );
    created.push({ bucket, client: otherS3 });

    const result = await runScript(bucket);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "アカウント 000000000000 のものとして確認できません",
    );
    expect(result.stdout).not.toContain("設定しました");
  });

  it("引数の誤りは 2 で終わる", async () => {
    const result = await runScript(newBucket("usage"), ["--fix"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("使い方:");
  });
});
