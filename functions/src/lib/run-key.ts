import type { TaskInput } from "../schemas/execution";

/**
 * タスク入力から論理キー（runKey）を作る（docs/05「論理キー（runKey）」）。
 * 再実行の前後で同じ値になり、送信記録のキーと S3 のキーに使う。SQS の重複排除 ID には使わない
 * （再実行のメッセージが 5 分以内なら重複として捨てられるため。docs/05「メールメッセージ」）。
 *
 * @param task - 検証済みのタスク入力
 * @returns `rerunOf` があればその値（最初の実行の名前）、無ければ実行名
 */
export function runKeyOf(
  task: Pick<TaskInput, "executionName" | "rerunOf">,
): string {
  return task.rerunOf ?? task.executionName;
}
