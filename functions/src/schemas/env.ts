import { z } from "zod";

/**
 * 全 Lambda に共通の環境変数（docs/09「環境変数」）。値は CDK が設定する。
 */
export const baseEnvSchema = z.object({
  /** ステージ名。ログの `stage` 項目に出す */
  STAGE: z.enum(["local", "dev"]),
});

/**
 * 投入 Lambda の環境変数。
 */
export const enqueueEnvSchema = baseEnvSchema.extend({
  /**
   * メール送信キューの URL。SDK の送信先になるため、スキームを http / https に限る
   * （`z.url()` だけでは `javascript:` なども通る。security.md「URL の検証」）。
   * LocalStack の URL は http のため https には絞らない
   */
  QUEUE_URL: z.url({ protocol: /^https?$/ }),
});
