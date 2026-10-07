import type { ExportWriter } from "../types/export";
import type { Logger } from "../types/logger";
import type { Recipient } from "../types/recipient";

/**
 * BigQuery の代わりに、書き込み件数を構造化ログへ出すスタブ。
 */
export class BigQueryStub implements ExportWriter {
  /**
   * @param logger - 呼び出し元の handler のロガー
   */
  constructor(private readonly logger: Logger) {}

  /**
   * 書き込み件数を 1 行のログに出す。
   *
   * @param executionName - 書き出しを行った実行の実行名
   * @param recipients - 書き出す配信対象
   * @returns ログを出し終えたら解決する
   */
  write(
    executionName: string,
    recipients: readonly Recipient[],
  ): Promise<void> {
    this.logger.info("BigQuery へ書き込みました（スタブ）", {
      stub: "bigquery",
      executionName,
      count: recipients.length,
    });
    return Promise.resolve();
  }
}
