/**
 * 1 通のメールを指すキー `<キー>:<配信対象 ID>` を作る（docs/05「メールメッセージ」「送信記録」）。
 * 投入 Lambda は実行名から SQS の重複排除 ID を、Consumer は論理キー（runKey）から送信記録のキーを作る。
 * 形は同じだが、守る範囲が違う。重複排除 ID は同じ実行の Retry、送信記録は再実行をまたいだ重複を防ぐ。
 * 再実行ではない実行では、論理キーが実行名と同じため 2 つは同じ値になる。
 *
 * @param key - 実行名（重複排除 ID）または論理キー（送信記録）
 * @param recipientId - 配信対象の ID
 * @returns `<キー>:<配信対象 ID>`
 */
export function messageKeyOf(key: string, recipientId: string): string {
  return `${key}:${recipientId}`;
}
