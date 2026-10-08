/**
 * 構造化ログに載せる追加項目。値は JSON に直列化できるものに限る（`undefined` の項目は出力されない）。
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * 1 行分の JSON 文字列を受け取って出力する先。本番は標準出力、テストでは配列への蓄積に差し替える。
 */
export type LogSink = (line: string) => void;

/**
 * 1 行 1 JSON の構造化ロガー（docs/04「運用性」）。
 * 出力の `level` / `message` は呼び出し側の項目より優先され、上書きされない。
 */
export type Logger = {
  /** 情報ログを 1 行出力する。出力に失敗しても例外を投げない（ログで処理を止めない） */
  info: (message: string, fields?: LogFields) => void;
  /** 警告ログを 1 行出力する。処理は続けるが、想定外の入力を受けたことを残すときに使う */
  warn: (message: string, fields?: LogFields) => void;
  /**
   * エラーログを 1 行出力する。エラーの名前・メッセージ・スタックトレースを項目に含める（error-handling.md）。
   * `Error` 以外の値が投げられた場合は、文字列にしてメッセージに入れる
   */
  error: (message: string, error: unknown, fields?: LogFields) => void;
  /**
   * 共通の項目を足したロガーを返す。元のロガーは変わらない。
   * 同じキーは後から足したもの（子・呼び出し時の項目）が優先される
   */
  child: (fields: LogFields) => Logger;
};
