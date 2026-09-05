import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { NotificationRecord, NotificationStore } from "./index";

type Item = Record<string, unknown>;
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;

function toRecord(i: Item): NotificationRecord {
  return {
    id: String(i.sk), type: i.type as NotificationRecord["type"], payload: (i.payload ?? {}) as Record<string, unknown>,
    read: i.read === true, createdAt: String(i.createdAt),
  };
}

export class DynamoNotificationStore implements NotificationStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async list(email: string, limit: number, before?: string) {
    const pk = pkOf(email);
    const out = await this.ddb.send(new QueryCommand({
      TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false, Limit: limit, ...(before ? { ExclusiveStartKey: { pk, sk: before } } : {}),
    }));
    const items = ((out.Items ?? []) as Item[]).map(toRecord);
    const next = out.LastEvaluatedKey?.sk as string | undefined;
    return next ? { items, next } : { items };
  }

  private async unreadPages(email: string, extra: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const pages: Array<Record<string, unknown>> = [];
    let ExclusiveStartKey: Item | undefined;
    do {
      const out = await this.ddb.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk", FilterExpression: "#read = :f",
        ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":pk": pkOf(email), ":f": false },
        ...extra, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      pages.push(out as Record<string, unknown>);
      ExclusiveStartKey = out.LastEvaluatedKey as Item | undefined;
    } while (ExclusiveStartKey);
    return pages;
  }

  async countUnread(email: string) {
    const pages = await this.unreadPages(email, { Select: "COUNT" });
    return pages.reduce((n, p) => n + Number(p.Count ?? 0), 0);
  }

  async markRead(email: string, ids: string[]) {
    await Promise.all(ids.map(async (sk) => {
      try {
        await this.ddb.send(new UpdateCommand({
          TableName: this.table, Key: { pk: pkOf(email), sk }, UpdateExpression: "SET #read = :t",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":t": true },
        }));
      } catch (e) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e; // a foreign or expired id is a no-op
      }
    }));
  }

  async markAllRead(email: string) {
    const pages = await this.unreadPages(email, { ProjectionExpression: "sk" });
    const ids = pages.flatMap((p) => ((p.Items ?? []) as Item[]).map((i) => String(i.sk)));
    if (ids.length > 0) await this.markRead(email, ids);
  }
}
