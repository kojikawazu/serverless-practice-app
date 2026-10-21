import type { NotifiedStatus } from "../schemas/execution-status-event";

/**
 * 実行の失敗を知らせる通知の内容（docs/07「スタブへの出力」の slack）。
 */
export type ExecutionFailureNotice = {
  executionName: string;
  executionArn: string;
  status: NotifiedStatus;
  /** エラー名。`TIMED_OUT` / `ABORTED` では `null` になりうる */
  error: string | null;
  /** エラーの原因。`TIMED_OUT` / `ABORTED` では `null` になりうる */
  cause: string | null;
};

/**
 * アラームが ALARM になったことを知らせる通知の内容（docs/07「スタブへの出力」の slack）。
 * 実行が始まっていない失敗（Scheduler の起動の失敗。#101）を知らせるため、実行名は持たない。
 */
export type AlarmNotice = {
  alarmName: string;
  /** CloudWatch が書く、ALARM になった理由の文。原因の詳細は DLQ のメッセージにある */
  reason: string;
};

/**
 * 失敗を知らせる口。本番構成では Slack、デモではスタブが実装する。
 */
export interface FailureNotifier {
  /**
   * 実行の失敗を 1 件知らせる。
   *
   * @param notice - 通知の内容
   */
  notify(notice: ExecutionFailureNotice): Promise<void>;

  /**
   * アラームが ALARM になったことを 1 件知らせる。
   *
   * @param notice - 通知の内容
   */
  notifyAlarm(notice: AlarmNotice): Promise<void>;
}
