import { z } from "zod";
import { loadHandlerContext } from "../lib/handler-context";
import { baseEnvSchema } from "../schemas/env";
import { executionStatusEventSchema } from "../schemas/execution-status-event";
import { SlackStub } from "../stubs/slack-stub";
import type { Logger } from "../types/logger";
import type { FailureNotifier } from "../types/notification";

/**
 * Slack 通知 Lambda の依存。Lambda の入口では本物のスタブを組み立てる。
 */
export type NotifySlackDeps = {
  notifier: FailureNotifier;
  logger: Logger;
};

/**
 * Step Functions の状態変化イベントを受け取り、実行の失敗を通知する（docs/03「Slack 通知 Lambda」）。
 *
 * 通知対象外のイベント（形式違い・対象外の状態）は、警告ログを出して正常に終える。
 * エラーにすると非同期呼び出しの再試行で同じイベントを繰り返し受けるだけで、結果は変わらないため。
 * 通知自体の失敗はエラーログを出してから投げ直し、Lambda の再試行に任せる。
 *
 * @param event - EventBridge から届くイベント（未検証）
 * @param deps - 依存
 * @returns 通知し終えたら（または対象外と判断したら）解決する
 * @throws {Error} 通知先が失敗した場合（通知先の例外をそのまま投げる）
 */
export async function notifySlack(
  event: unknown,
  deps: NotifySlackDeps,
): Promise<void> {
  const parsed = executionStatusEventSchema.safeParse(event);
  if (!parsed.success) {
    deps.logger.warn("通知対象外のイベントのため通知しません", {
      reason: z.prettifyError(parsed.error),
    });
    return;
  }

  const { detail } = parsed.data;
  const logger = deps.logger.child({ executionName: detail.name });
  try {
    await deps.notifier.notify({
      executionName: detail.name,
      executionArn: detail.executionArn,
      status: detail.status,
      // 項目自体が無い場合も「無し」として null に揃える（通知の形を一定にする）
      error: detail.error ?? null,
      cause: detail.cause ?? null,
    });
  } catch (error) {
    logger.error("失敗の通知に失敗しました", error);
    throw error;
  }
}

/**
 * Lambda の入口。環境変数から依存を組み立てて `notifySlack` を呼ぶ。
 *
 * @param event - EventBridge から届くイベント
 * @returns 通知し終えたら解決する
 * @throws {ValidationError} 環境変数が不正な場合
 */
export async function handler(event: unknown): Promise<void> {
  const { logger } = loadHandlerContext("notify-slack", baseEnvSchema);
  await notifySlack(event, { notifier: new SlackStub(logger), logger });
}
