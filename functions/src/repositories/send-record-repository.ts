import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { BeginSendResult, SendRecordStore } from "../types/send-record";

/**
 * 送信記録を残す期間（秒）。7 日。メッセージが再び届きうる期間（キュー 1 日・DLQ 4 日。docs/04「保持期間」）より
 * 長く取る。期限を過ぎた記録は DynamoDB の TTL が非同期に消す（docs/05「送信記録」）
 */
const SEND_RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 送信記録の状態。DynamoDB の項目 `status` に入る値 */
const STATUS = { sending: "SENDING", sent: "SENT" } as const;

/**
 * 条件付きの書き込みで、条件に合わなかったことを表す DynamoDB のエラー名。
 * クラスの instanceof ではなく名前で見分ける（SDK の版やモックでクラスが別物になっても判定がずれないように）
 */
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

/**
 * 条件付きの書き込みが、条件に合わずに断られたかを判定する。
 *
 * @param error - DynamoDB の呼び出しが投げた値
 * @returns 条件に合わなかったことによる失敗なら `true`
 */
function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === CONDITIONAL_CHECK_FAILED;
}

/**
 * DynamoDB のテーブルに送信記録を置く（docs/05「送信記録」）。
 * キーは `messageKey`（`<論理キー>:<配信対象 ID>`）、状態は `status`（`SENDING` / `SENT`）、期限は `expiresAt`（エポック秒）。
 */
export class DynamoDbSendRecordStore implements SendRecordStore {
  /**
   * @param client - DynamoDB クライアント
   * @param tableName - 送信記録のテーブル名
   * @param now - 現在時刻を返す関数。テストで期限の計算を固定するために差し替える
   */
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 記録が無ければ「送信中」を書く。あれば、強い整合性で読み直してその状態を返す。
   *
   * @param messageKey - メールのキー
   * @returns 書き始めた結果。送信済みなら `"sent"`、それ以外の記録（送信中・読めない）なら `"unknown"`
   * @throws {Error} 条件に合わなかったこと以外で DynamoDB の呼び出しが失敗した場合
   */
  async begin(messageKey: string): Promise<BeginSendResult> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            messageKey: { S: messageKey },
            status: { S: STATUS.sending },
            expiresAt: { N: String(this.expiresAt()) },
          },
          ConditionExpression: "attribute_not_exists(messageKey)",
        }),
      );
      return "started";
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
    }

    const { Item } = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: { messageKey: { S: messageKey } },
        // 書き込みを断られた直後に読むため、結果整合の読み取りで古い値（記録が無い）を見ないようにする
        ConsistentRead: true,
      }),
    );
    // 記録が読めない（書き込みを断られた後に期限で消えたなど）ときも、送ったかどうかは判定できない側に倒す
    return Item?.["status"]?.S === STATUS.sent ? "sent" : "unknown";
  }

  /**
   * 記録を「送信済み」にし、期限を延ばす。
   *
   * @param messageKey - メールのキー
   * @throws {Error} DynamoDB の呼び出しが失敗した場合
   */
  async markSent(messageKey: string): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { messageKey: { S: messageKey } },
        // status は DynamoDB の予約語のため、名前を置き換えて書く
        UpdateExpression: "SET #status = :sent, expiresAt = :expiresAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":sent": { S: STATUS.sent },
          ":expiresAt": { N: String(this.expiresAt()) },
        },
      }),
    );
  }

  /**
   * 「送信中」の記録を消す。「送信済み」の記録や、記録が無いときは何もしない。
   *
   * @param messageKey - メールのキー
   * @throws {Error} 条件に合わなかったこと以外で DynamoDB の呼び出しが失敗した場合
   */
  async release(messageKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: { messageKey: { S: messageKey } },
          ConditionExpression: "#status = :sending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":sending": { S: STATUS.sending } },
        }),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
    }
  }

  /**
   * 今から送信記録を残す期間だけ先の時刻を、エポック秒で返す。
   *
   * @returns 記録の期限（エポック秒）
   */
  private expiresAt(): number {
    return Math.floor(this.now().getTime() / 1000) + SEND_RECORD_TTL_SECONDS;
  }
}
