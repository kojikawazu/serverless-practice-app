/**
 * 1 通のメールを指すキー `<実行名>:<配信対象 ID>` を作る（docs/05「メールメッセージ」「送信記録」）。
 * 投入 Lambda は SQS の重複排除 ID に、Consumer は送信記録のキーに使う。
 * 2 つが同じ値であることで、同じ実行の同じ宛先のメールを、積む側と送る側の両方で 1 通として扱える。
 *
 * @param executionName - 投入したステートマシンの実行名
 * @param recipientId - 配信対象の ID
 * @returns `<実行名>:<配信対象 ID>`
 */
export function messageKeyOf(
  executionName: string,
  recipientId: string,
): string {
  return `${executionName}:${recipientId}`;
}
