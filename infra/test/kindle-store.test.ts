import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { derivedDeviceId, type DeviceList } from "../lambda/kindle/devices";
import { DynamoKindleStore } from "../lambda/kindle/store";

const NOW = "2026-09-06T12:00:00.000Z";
function client(item?: Record<string, unknown>) {
  const sent: unknown[] = [];
  const ddb = { send: vi.fn(async (cmd: unknown) => { sent.push(cmd); return cmd instanceof GetCommand ? { Item: item } : {}; }) };
  return { ddb: ddb as never, sent };
}

describe("DynamoKindleStore", () => {
  it("reads the caller's own row only", async () => {
    const { ddb, sent } = client({ devices: [], defaultDeviceId: null });
    await new DynamoKindleStore(ddb, "T").getDevices("Jay@Example.com");
    expect((sent[0] as GetCommand).input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
  });

  it("migrates a legacy address row on read without writing", async () => {
    const { ddb, sent } = client({ kindleAddress: "me_x@kindle.com", updatedAt: NOW });
    const list = await new DynamoKindleStore(ddb, "T").getDevices("jay@example.com");
    expect(list.devices).toEqual([{ id: derivedDeviceId("me_x@kindle.com"), label: "", address: "me_x@kindle.com", addedAt: NOW }]);
    expect(sent).toHaveLength(1);
  });

  it("reads a missing row as an empty list", async () => {
    const { ddb } = client(undefined);
    expect(await new DynamoKindleStore(ddb, "T").getDevices("jay@example.com")).toEqual({ devices: [], defaultDeviceId: null });
  });

  it("writes the whole item, dropping any legacy field", async () => {
    const { ddb, sent } = client();
    const list: DeviceList = { devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: NOW }], defaultDeviceId: "aaaaaaaa" };
    await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", list, NOW);
    expect((sent[0] as PutCommand).input).toEqual({
      TableName: "T",
      Item: { pk: "USER#jay@example.com", sk: "SETTINGS", devices: list.devices, defaultDeviceId: "aaaaaaaa", updatedAt: NOW },
    });
  });

  it("deletes the row when the list is empty", async () => {
    const { ddb, sent } = client();
    await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", { devices: [], defaultDeviceId: null }, NOW);
    expect(sent[0]).toBeInstanceOf(DeleteCommand);
    expect((sent[0] as DeleteCommand).input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
  });
});
