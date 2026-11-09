import type { ExportRun, ExportWriter } from "../types/export";
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
   * @param run - 書き出しを行った実行。`runKey` も出し、再実行で同じ論理キーの書き込みが 2 回起きたことを見分けられるようにする
   * @param recipients - 書き出す配信対象
   * @returns ログを出し終えたら解決する
   */
  write(run: ExportRun, recipients: readonly Recipient[]): Promise<void> {
    this.logger.info("BigQuery へ書き込みました（スタブ）", {
      stub: "bigquery",
      executionName: run.executionName,
      runKey: run.runKey,
      count: recipients.length,
    });
    return Promise.resolve();
  }
}
