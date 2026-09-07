import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readDevices, type DeviceList } from "./devices";
import type { KindleStore, SetDevicesResult, StoredDevices } from "./index";

const SK = "SETTINGS";
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;

// The row's `updatedAt` doubles as its version. `undefined` means the caller has no
// expectation — an older client that predates the version field — and writes
// unconditionally. `null` means the caller believes there is no row yet. A string must
// still be the row's `updatedAt`, or another tab has written since the caller read.
function guard(expected: string | null | undefined) {
  if (expected === undefined) return {};
  if (expected === null) return { ConditionExpression: "attribute_not_exists(pk)" };
  return {
    ConditionExpression: "attribute_not_exists(pk) OR updatedAt = :seen",
    ExpressionAttributeValues: { ":seen": expected },
  };
}

// Per-user settings live in the library table next to the overlay rows; only the
// caller's own pk is ever touched. A legacy {kindleAddress} row is migrated on read
// and disappears on the next write, because Put replaces the whole item.
export class DynamoKindleStore implements KindleStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async getDevices(email: string): Promise<StoredDevices> {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
    const stamp = out.Item?.updatedAt;
    return { ...readDevices(out.Item), version: typeof stamp === "string" ? stamp : null };
  }

  async setDevices(email: string, list: DeviceList, updatedAt: string, expectedVersion?: string | null): Promise<SetDevicesResult> {
    const condition = guard(expectedVersion);
    try {
      if (list.devices.length === 0) {
        await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK }, ...condition }));
        return { ok: true, version: null };
      }
      await this.ddb.send(new PutCommand({
        TableName: this.table,
        Item: { pk: pkOf(email), sk: SK, devices: list.devices, defaultDeviceId: list.defaultDeviceId, updatedAt },
        ...condition,
      }));
      return { ok: true, version: updatedAt };
    } catch (e) {
      // Matched by name rather than instanceof: the exception class the document client
      // throws comes from whichever copy of the DynamoDB client the bundle resolved.
      if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return { ok: false, reason: "stale" };
      throw e;
    }
  }
}
