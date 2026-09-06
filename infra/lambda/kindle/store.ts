import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readDevices, type DeviceList } from "./devices";
import type { KindleStore } from "./index";

const SK = "SETTINGS";
const pkOf = (email: string) => `USER#${email.toLowerCase()}`;

// Per-user settings live in the library table next to the overlay rows; only the
// caller's own pk is ever touched. A legacy {kindleAddress} row is migrated on read
// and disappears on the next write, because Put replaces the whole item.
export class DynamoKindleStore implements KindleStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly table: string) {}

  async getDevices(email: string): Promise<DeviceList> {
    const out = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
    return readDevices(out.Item);
  }

  async setDevices(email: string, list: DeviceList, updatedAt: string): Promise<void> {
    if (list.devices.length === 0) {
      await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: pkOf(email), sk: SK } }));
      return;
    }
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { pk: pkOf(email), sk: SK, devices: list.devices, defaultDeviceId: list.defaultDeviceId, updatedAt },
    }));
  }
}
