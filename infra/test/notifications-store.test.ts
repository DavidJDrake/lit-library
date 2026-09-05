import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoNotificationStore } from "../lambda/notifications/store";

const row = (sk: string, read = false) => ({
  pk: "USER#a@example.com", sk, type: "books_added", payload: { count: 1, bookIds: ["x"] }, read, createdAt: sk.split("#")[0], expiresAt: 1,
});
function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}
function condFail() { const e = new Error("cond") as Error & { name: string }; e.name = "ConditionalCheckFailedException"; return e; }

describe("DynamoNotificationStore.list", () => {
  it("queries newest-first with the limit and cursor and maps rows to records", async () => {
    const { ddb, send } = client(() => ({ Items: [row("2026-09-05T10:00:00.000Z#b"), row("2026-09-05T09:00:00.000Z#a", true)], LastEvaluatedKey: { pk: "USER#a@example.com", sk: "2026-09-05T09:00:00.000Z#a" } }));
    const out = await new DynamoNotificationStore(ddb, "T").list("a@example.com", 2, "2026-09-05T11:00:00.000Z#c");
    const cmd = send.mock.calls[0][0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input).toEqual({
      TableName: "T", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "USER#a@example.com" },
      ScanIndexForward: false, Limit: 2, ExclusiveStartKey: { pk: "USER#a@example.com", sk: "2026-09-05T11:00:00.000Z#c" },
    });
    expect(out.items).toEqual([
      { id: "2026-09-05T10:00:00.000Z#b", type: "books_added", payload: { count: 1, bookIds: ["x"] }, read: false, createdAt: "2026-09-05T10:00:00.000Z" },
      { id: "2026-09-05T09:00:00.000Z#a", type: "books_added", payload: { count: 1, bookIds: ["x"] }, read: true, createdAt: "2026-09-05T09:00:00.000Z" },
    ]);
    expect(out.next).toBe("2026-09-05T09:00:00.000Z#a");
  });
  it("omits next on the last page and ExclusiveStartKey without a cursor", async () => {
    const { ddb, send } = client(() => ({ Items: [] }));
    const out = await new DynamoNotificationStore(ddb, "T").list("a@example.com", 50);
    expect(out).toEqual({ items: [] });
    expect((send.mock.calls[0][0] as QueryCommand).input).not.toHaveProperty("ExclusiveStartKey");
  });
});

describe("DynamoNotificationStore.countUnread", () => {
  it("sums COUNT queries across pages with the read=false filter", async () => {
    const pages = [{ Count: 3, LastEvaluatedKey: { pk: "p", sk: "s" } }, { Count: 2 }];
    const { ddb, send } = client(() => pages.shift());
    expect(await new DynamoNotificationStore(ddb, "T").countUnread("a@example.com")).toBe(5);
    const cmd = send.mock.calls[0][0] as QueryCommand;
    expect(cmd.input).toMatchObject({
      TableName: "T", Select: "COUNT", KeyConditionExpression: "pk = :pk", FilterExpression: "#read = :f",
      ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":pk": "USER#a@example.com", ":f": false },
    });
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: "p", sk: "s" });
  });
});

describe("DynamoNotificationStore.markRead / markAllRead", () => {
  it("updates each id under the caller's pk, ignoring ids that do not exist", async () => {
    let n = 0;
    const { ddb, send } = client(() => { n += 1; if (n === 2) throw condFail(); return {}; });
    await new DynamoNotificationStore(ddb, "T").markRead("a@example.com", ["2026-09-05T10:00:00.000Z#b", "2026-09-05T09:00:00.000Z#zz"]);
    expect(send).toHaveBeenCalledTimes(2);
    const cmd = send.mock.calls[0][0] as UpdateCommand;
    expect(cmd).toBeInstanceOf(UpdateCommand);
    expect(cmd.input).toEqual({
      TableName: "T", Key: { pk: "USER#a@example.com", sk: "2026-09-05T10:00:00.000Z#b" },
      UpdateExpression: "SET #read = :t", ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#read": "read" }, ExpressionAttributeValues: { ":t": true },
    });
  });
  it("markAllRead finds unread keys then updates them", async () => {
    const { ddb, send } = client((cmd) => (cmd instanceof QueryCommand ? { Items: [{ sk: "2026-09-05T10:00:00.000Z#b" }, { sk: "2026-09-05T09:00:00.000Z#a" }] } : {}));
    await new DynamoNotificationStore(ddb, "T").markAllRead("a@example.com");
    const q = send.mock.calls[0][0] as QueryCommand;
    expect(q.input).toMatchObject({ ProjectionExpression: "sk", FilterExpression: "#read = :f" });
    expect(send.mock.calls.slice(1).map((c) => (c[0] as UpdateCommand).input.Key)).toEqual([
      { pk: "USER#a@example.com", sk: "2026-09-05T10:00:00.000Z#b" }, { pk: "USER#a@example.com", sk: "2026-09-05T09:00:00.000Z#a" },
    ]);
  });
  it("rethrows unexpected errors", async () => {
    const { ddb } = client(() => { throw new Error("network"); });
    await expect(new DynamoNotificationStore(ddb, "T").markRead("a@example.com", ["2026-09-05T10:00:00.000Z#b"])).rejects.toThrow("network");
  });
});
