import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

// Read-only view of the downloads table (owned by the Api construct — see
// infra/lib/api.ts) for the library Lambda's "downloaded" overlay. The library Lambda is
// granted read access only: it never writes here.
export interface DownloadsStore {
  /** Distinct book ids the reader has ever obtained (direct download or Kindle send). */
  listDownloadedBookIds(email: string): Promise<string[]>;
}

type Item = Record<string, unknown>;

export class DynamoDownloadsStore implements DownloadsStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async listDownloadedBookIds(email: string): Promise<string[]> {
    const ids = new Set<string>();
    let ExclusiveStartKey: Item | undefined;
    do {
      const out = await this.ddb.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": email },
        ProjectionExpression: "bookId",
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      for (const item of (out.Items ?? []) as Item[]) {
        if (typeof item.bookId === "string") ids.add(item.bookId);
      }
      ExclusiveStartKey = out.LastEvaluatedKey as Item | undefined;
    } while (ExclusiveStartKey);
    return [...ids];
  }
}
