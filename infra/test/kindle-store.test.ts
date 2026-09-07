import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { derivedDeviceId, type DeviceList } from "../lambda/kindle/devices";
import { DynamoKindleStore } from "../lambda/kindle/store";

const NOW = "2026-09-06T12:00:00.000Z";
function client(item?: Record<string, unknown>, opts: { conditionFails?: boolean } = {}) {
  const sent: unknown[] = [];
  const ddb = { send: vi.fn(async (cmd: unknown) => {
    sent.push(cmd);
    if (cmd instanceof GetCommand) return { Item: item };
    if (opts.conditionFails) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
    return {};
  }) };
  return { ddb: ddb as never, sent };
}
const LIST: DeviceList = { devices: [{ id: "aaaaaaaa", label: "Scribe", address: "a@kindle.com", addedAt: NOW }], defaultDeviceId: "aaaaaaaa" };
const EMPTY: DeviceList = { devices: [], defaultDeviceId: null };

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

  it("reads a missing row as an empty list with no version", async () => {
    const { ddb } = client(undefined);
    expect(await new DynamoKindleStore(ddb, "T").getDevices("jay@example.com")).toEqual({ devices: [], defaultDeviceId: null, version: null });
  });

  it("returns the row's updatedAt as the version", async () => {
    const { ddb } = client({ devices: LIST.devices, defaultDeviceId: "aaaaaaaa", updatedAt: NOW });
    expect((await new DynamoKindleStore(ddb, "T").getDevices("jay@example.com")).version).toBe(NOW);
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
    const out = await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", EMPTY, NOW);
    expect(sent[0]).toBeInstanceOf(DeleteCommand);
    expect((sent[0] as DeleteCommand).input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
    expect(out).toEqual({ ok: true, version: null });
  });

  it("writes unconditionally and reports the new version when no version is expected", async () => {
    const { ddb, sent } = client();
    const out = await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", LIST, NOW);
    expect((sent[0] as PutCommand).input.ConditionExpression).toBeUndefined();
    expect(out).toEqual({ ok: true, version: NOW });
  });

  it("conditions the write on the version the caller last read", async () => {
    const seen = "2026-09-05T09:00:00.000Z";
    const { ddb, sent } = client();
    await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", LIST, NOW, seen);
    const input = (sent[0] as PutCommand).input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(pk) OR updatedAt = :seen");
    expect(input.ExpressionAttributeValues).toEqual({ ":seen": seen });
  });

  it("requires the row to be absent when the caller read no row", async () => {
    const { ddb, sent } = client();
    await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", LIST, NOW, null);
    expect((sent[0] as PutCommand).input.ConditionExpression).toBe("attribute_not_exists(pk)");
  });

  it("conditions the delete path the same way", async () => {
    const seen = "2026-09-05T09:00:00.000Z";
    const { ddb, sent } = client();
    await new DynamoKindleStore(ddb, "T").setDevices("jay@example.com", EMPTY, NOW, seen);
    const input = (sent[0] as DeleteCommand).input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(pk) OR updatedAt = :seen");
    expect(input.ExpressionAttributeValues).toEqual({ ":seen": seen });
  });

  it("reports a failed condition as stale rather than throwing, on both paths", async () => {
    const seen = "2026-09-05T09:00:00.000Z";
    const put = client(undefined, { conditionFails: true });
    expect(await new DynamoKindleStore(put.ddb, "T").setDevices("jay@example.com", LIST, NOW, seen)).toEqual({ ok: false, reason: "stale" });
    const del = client(undefined, { conditionFails: true });
    expect(await new DynamoKindleStore(del.ddb, "T").setDevices("jay@example.com", EMPTY, NOW, seen)).toEqual({ ok: false, reason: "stale" });
  });

  it("still propagates any other write failure", async () => {
    const ddb = { send: vi.fn(async (cmd: unknown) => { if (cmd instanceof GetCommand) return {}; throw new Error("ddb down"); }) };
    await expect(new DynamoKindleStore(ddb as never, "T").setDevices("jay@example.com", LIST, NOW, NOW)).rejects.toThrow("ddb down");
  });
});
