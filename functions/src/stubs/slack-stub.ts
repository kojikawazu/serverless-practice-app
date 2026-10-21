import type { Logger } from "../types/logger";
import type {
  AlarmNotice,
  ExecutionFailureNotice,
  FailureNotifier,
} from "../types/notification";

/**
 * Slack の代わりに、通知内容を構造化ログへ出すスタブ。
 */
export class SlackStub implements FailureNotifier {
  /**
   * @param logger - 呼び出し元の handler のロガー
   */
  constructor(private readonly logger: Logger) {}

  /**
   * 通知内容を 1 行のログに出す。
   *
   * @param notice - 通知の内容
   * @returns ログを出し終えたら解決する
   */
  notify(notice: ExecutionFailureNotice): Promise<void> {
    this.logger.info("実行の失敗を通知しました（スタブ）", {
      stub: "slack",
      executionName: notice.executionName,
      executionArn: notice.executionArn,
      status: notice.status,
      error: notice.error,
      cause: notice.cause,
    });
    return Promise.resolve();
  }

  /**
   * アラームの通知内容を 1 行のログに出す。
   *
   * @param notice - 通知の内容
   * @returns ログを出し終えたら解決する
   */
  notifyAlarm(notice: AlarmNotice): Promise<void> {
    this.logger.info("アラームを通知しました（スタブ）", {
      stub: "slack",
      alarmName: notice.alarmName,
      reason: notice.reason,
    });
    return Promise.resolve();
  }
}
