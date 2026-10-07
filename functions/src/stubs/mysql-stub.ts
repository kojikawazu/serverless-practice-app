import type { Recipient, RecipientRepository } from "../types/recipient";

/**
 * 配信対象の固定データ。実在の宛先を持たないよう、ドメインは `example.com` に限る（docs/06「データ保護」）。
 */
const RECIPIENTS: readonly Recipient[] = [
  { recipientId: "r-001", email: "user1@example.com", name: "利用者 1" },
  { recipientId: "r-002", email: "user2@example.com", name: "利用者 2" },
  { recipientId: "r-003", email: "user3@example.com", name: "利用者 3" },
];

/**
 * MySQL の代わりに固定の配信対象を返すスタブ。読み取りのみで、ログは出さない。
 */
export class MySqlStub implements RecipientRepository {
  /**
   * 固定の配信対象 3 件を返す。
   *
   * @returns 配信対象の写し。呼び出し側が変更しても固定データは変わらない
   */
  findAll(): Promise<readonly Recipient[]> {
    return Promise.resolve(RECIPIENTS.map((recipient) => ({ ...recipient })));
  }
}
