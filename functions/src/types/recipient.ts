/**
 * 配信対象（メールの宛先）。MySQL スタブが返す固定データ（docs/05「配信対象」）。
 */
export type Recipient = {
  /** 配信対象の ID。`r-001` 形式で、データ内で一意 */
  recipientId: string;
  /** 宛先メールアドレス。`@example.com` に限る（実在の宛先を持たない） */
  email: string;
  /** 表示名 */
  name: string;
};

/**
 * 配信対象を取得する口。本番構成では MySQL、デモではスタブが実装する。
 */
export interface RecipientRepository {
  /**
   * 配信対象の全件を取得する。
   *
   * @returns 配信対象の一覧。呼び出し側が変更しても次回の結果に影響しない
   */
  findAll(): Promise<readonly Recipient[]>;
}
