import { DeleteCommand, GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoKindleStore } from "../lambda/kindle/store";

function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}

describe("DynamoKindleStore", () => {
  it("reads the caller's SETTINGS row", async () => {
    const { ddb, send } = client(() => ({ Item: { pk: "USER#jay@example.com", sk: "SETTINGS", kindleAddress: "jay_abc@kindle.com" } }));
    expect(await new DynamoKindleStore(ddb, "T").getAddress("jay@example.com")).toBe("jay_abc@kindle.com");
    const cmd = send.mock.calls[0][0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
    const none = client(() => ({}));
    expect(await new DynamoKindleStore(none.ddb, "T").getAddress("jay@example.com")).toBeNull();
  });
  it("writes the row on set and deletes it on null", async () => {
    const { ddb, send } = client(() => ({}));
    const store = new DynamoKindleStore(ddb, "T");
    await store.setAddress("jay@example.com", "jay_abc@kindle.com", "2026-09-05T12:00:00.000Z");
    const put = send.mock.calls[0][0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input).toEqual({ TableName: "T", Item: { pk: "USER#jay@example.com", sk: "SETTINGS", kindleAddress: "jay_abc@kindle.com", updatedAt: "2026-09-05T12:00:00.000Z" } });
    await store.setAddress("jay@example.com", null, "2026-09-05T12:00:00.000Z");
    const del = send.mock.calls[1][0] as DeleteCommand;
    expect(del).toBeInstanceOf(DeleteCommand);
    expect(del.input).toEqual({ TableName: "T", Key: { pk: "USER#jay@example.com", sk: "SETTINGS" } });
  });
});
