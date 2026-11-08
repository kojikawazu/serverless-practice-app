import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { DynamoDbSendRecordStore } from "../../src/repositories/send-record-repository";

const TABLE = "serverless-practice-app-local-send-records";
const KEY = "run-1:r-001";

/** 期限の計算を固定する現在時刻（2026-11-08T00:00:00Z） */
const NOW = new Date("2026-11-08T00:00:00Z");
/** NOW の 7 日後（エポック秒） */
const EXPIRES_AT = String(NOW.getTime() / 1000 + 7 * 24 * 60 * 60);

// DynamoDB（外部 I/O）だけを差し替える
const dynamodbMock = mockClient(DynamoDBClient);

/**
 * 条件付きの書き込みが条件に合わなかったときに、SDK が投げる例外を作る。
 *
 * @returns 例外
 */
function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });
}

/**
 * テスト対象を組み立てる。
 *
 * @returns 送信記録
 */
function store(): DynamoDbSendRecordStore {
  return new DynamoDbSendRecordStore(new DynamoDBClient({}), TABLE, () => NOW);
}

beforeEach(() => {
  dynamodbMock.reset();
});

describe("DynamoDbSendRecordStore", () => {
  describe("正常系", () => {
    it("begin: 記録が無ければ、キーが無いことを条件に送信中を 7 日後の期限で書き、started を返す", async () => {
      dynamodbMock.on(PutItemCommand).resolves({});

      await expect(store().begin(KEY)).resolves.toBe("started");

      expect(
        dynamodbMock.commandCalls(PutItemCommand)[0]?.args[0].input,
      ).toEqual({
        TableName: TABLE,
        Item: {
          messageKey: { S: KEY },
          status: { S: "SENDING" },
          expiresAt: { N: EXPIRES_AT },
        },
        ConditionExpression: "attribute_not_exists(messageKey)",
      });
      expect(dynamodbMock.commandCalls(GetItemCommand)).toHaveLength(0);
    });

    it("begin: 送信済みの記録があれば、強い整合性で読み直して sent を返す", async () => {
      dynamodbMock.on(PutItemCommand).rejects(conditionalCheckFailed());
      dynamodbMock
        .on(GetItemCommand)
        .resolves({ Item: { messageKey: { S: KEY }, status: { S: "SENT" } } });

      await expect(store().begin(KEY)).resolves.toBe("sent");

      expect(
        dynamodbMock.commandCalls(GetItemCommand)[0]?.args[0].input,
      ).toEqual({
        TableName: TABLE,
        Key: { messageKey: { S: KEY } },
        ConsistentRead: true,
      });
    });

    it("markSent: 状態を送信済みにし、期限を 7 日後に延ばす", async () => {
      dynamodbMock.on(UpdateItemCommand).resolves({});

      await store().markSent(KEY);

      expect(
        dynamodbMock.commandCalls(UpdateItemCommand)[0]?.args[0].input,
      ).toEqual({
        TableName: TABLE,
        Key: { messageKey: { S: KEY } },
        UpdateExpression: "SET #status = :sent, expiresAt = :expiresAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":sent": { S: "SENT" },
          ":expiresAt": { N: EXPIRES_AT },
        },
      });
    });

    it("release: 送信中であることを条件に記録を消す", async () => {
      dynamodbMock.on(DeleteItemCommand).resolves({});

      await store().release(KEY);

      expect(
        dynamodbMock.commandCalls(DeleteItemCommand)[0]?.args[0].input,
      ).toEqual({
        TableName: TABLE,
        Key: { messageKey: { S: KEY } },
        ConditionExpression: "#status = :sending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":sending": { S: "SENDING" } },
      });
    });
  });

  describe("準正常系", () => {
    it("begin: 送信中の記録が残っていれば unknown を返す", async () => {
      dynamodbMock.on(PutItemCommand).rejects(conditionalCheckFailed());
      dynamodbMock.on(GetItemCommand).resolves({
        Item: { messageKey: { S: KEY }, status: { S: "SENDING" } },
      });

      await expect(store().begin(KEY)).resolves.toBe("unknown");
    });

    it("begin: 書き込みを断られた後に記録が読めなければ、判定できない側（unknown）に倒す", async () => {
      dynamodbMock.on(PutItemCommand).rejects(conditionalCheckFailed());
      dynamodbMock.on(GetItemCommand).resolves({});

      await expect(store().begin(KEY)).resolves.toBe("unknown");
    });

    it("release: 送信中でない（送信済み・記録が無い）ため条件に合わなければ、何もせずに終える", async () => {
      dynamodbMock.on(DeleteItemCommand).rejects(conditionalCheckFailed());

      await expect(store().release(KEY)).resolves.toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("begin: 条件に合わなかったこと以外の失敗は、そのまま投げ、読み直さない", async () => {
      dynamodbMock
        .on(PutItemCommand)
        .rejects(new Error("ProvisionedThroughputExceeded"));

      await expect(store().begin(KEY)).rejects.toThrow(
        "ProvisionedThroughputExceeded",
      );
      expect(dynamodbMock.commandCalls(GetItemCommand)).toHaveLength(0);
    });

    it("begin: 読み直しが失敗したら、そのまま投げる", async () => {
      dynamodbMock.on(PutItemCommand).rejects(conditionalCheckFailed());
      dynamodbMock.on(GetItemCommand).rejects(new Error("InternalServerError"));

      await expect(store().begin(KEY)).rejects.toThrow("InternalServerError");
    });

    it("markSent: 失敗したら、そのまま投げる", async () => {
      dynamodbMock
        .on(UpdateItemCommand)
        .rejects(new Error("InternalServerError"));

      await expect(store().markSent(KEY)).rejects.toThrow(
        "InternalServerError",
      );
    });

    it("release: 条件に合わなかったこと以外の失敗は、そのまま投げる", async () => {
      dynamodbMock
        .on(DeleteItemCommand)
        .rejects(new Error("InternalServerError"));

      await expect(store().release(KEY)).rejects.toThrow("InternalServerError");
    });
  });
});
