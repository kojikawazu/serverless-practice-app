/** デプロイ先のステージ。値と順序は docs/10「用語集」の「ステージ」 */
export const STAGES = [
  /** LocalStack（手元） */
  "local",
  /** 実 AWS の検証用アカウント */
  "dev",
] as const;

/** デプロイ先のステージ */
export type Stage = (typeof STAGES)[number];

/**
 * CDK のコンテキスト（`-c stage=...`）からステージを取り出す。
 *
 * @param value - `app.node.tryGetContext("stage")` の値
 * @returns 検証済みのステージ
 * @throws {Error} 未指定、または `local` / `dev` 以外の場合（既定値に倒さず、デプロイ先を必ず明示させる）
 */
export function parseStage(value: unknown): Stage {
  const stage = STAGES.find((candidate) => candidate === value);
  if (stage === undefined) {
    throw new Error(
      `ステージを -c stage=${STAGES.join("|")} で指定してください（指定値: ${String(value)}）`,
    );
  }
  return stage;
}
