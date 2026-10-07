import type { Recipient } from "./recipient";

/**
 * データ連携の書き出し先の口。BigQuery スタブと Cuenote FC スタブが実装する。
 * 書き出し先ごとに別の口にしないのは、データ連携 Lambda から見た振る舞い（全件を書く）が同じため。
 */
export interface ExportWriter {
  /**
   * 配信対象の全件を書き出す。
   *
   * @param executionName - 書き出しを行った実行の実行名
   * @param recipients - 書き出す配信対象
   */
  write(executionName: string, recipients: readonly Recipient[]): Promise<void>;
}
