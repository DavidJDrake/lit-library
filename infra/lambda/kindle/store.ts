import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { KindleStore } from "./index";

const SK = "SETTINGS";
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;

// Per-user settings live in the library table next to the overlay rows; only the
// caller's own pk is ever touched.
export class DynamoKindleStore implements KindleStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async getAddress(email: string): Promise<string | null> {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
    const v = out.Item?.kindleAddress;
    return typeof v === "string" && v ? v : null;
  }

  async setAddress(email: string, address: string | null, updatedAt: string): Promise<void> {
    if (address === null) {
      await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
      return;
    }
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { pk: pkOf(email), sk: SK, kindleAddress: address, updatedAt } }));
  }
}
