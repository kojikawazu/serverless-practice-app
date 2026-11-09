import type { Recipient } from "./recipient";

/**
 * 書き出しを行った実行。書き出し先のスタブがログに出し、同じ論理キーの書き込みが 2 回起きたことを見分けるために使う
 * （docs/07「スタブへの出力」）。
 */
export type ExportRun = {
  /** 書き出しを行った実行の実行名 */
  executionName: string;
  /** 論理キー（docs/05「論理キー（runKey）」）。再実行では最初の実行の名前 */
  runKey: string;
};

/**
 * データ連携の書き出し先の口。BigQuery スタブと Cuenote FC スタブが実装する。
 * 書き出し先ごとに別の口にしないのは、データ連携 Lambda から見た振る舞い（全件を書く）が同じため。
 */
export interface ExportWriter {
  /**
   * 配信対象の全件を書き出す。
   *
   * @param run - 書き出しを行った実行
   * @param recipients - 書き出す配信対象
   */
  write(run: ExportRun, recipients: readonly Recipient[]): Promise<void>;
}
