import { BatchWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ListUsersCommand, ListUsersInGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it, vi } from "vitest";
import {
  buildRows, CognitoDirectory, DynamoNotificationWriter, notify, TTL_DAYS, type NotificationRow, type NotifyDeps,
} from "../lambda/notifications/fanout";

const NOW = new Date("2026-09-05T10:00:00.000Z");

function user(email: string, status = "EXTERNAL_PROVIDER", enabled = true) {
  return { Username: `Google_${email}`, Enabled: enabled, UserStatus: status, Attributes: [{ Name: "email", Value: email }] };
}

describe("buildRows", () => {
  it("keys rows by recipient, orders sk by time then id, and sets the TTL", () => {
    const rows = buildRows("books_added", { count: 2, bookIds: ["a", "b"] }, ["x@example.com", "y@example.com"], NOW, () => "id-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pk: "USER#x@example.com", sk: "2026-09-05T10:00:00.000Z#id-1", type: "books_added",
      payload: { count: 2, bookIds: ["a", "b"] }, read: false, createdAt: "2026-09-05T10:00:00.000Z",
      expiresAt: Math.floor(NOW.getTime() / 1000) + TTL_DAYS * 86_400,
    });
    expect(rows[1].pk).toBe("USER#y@example.com");
  });
  it("dedupes recipients case-insensitively", () => {
    expect(buildRows("category_created", { name: "X" }, ["A@example.com", "a@example.com"], NOW, () => "i")).toHaveLength(1);
  });
});

describe("notify", () => {
  function deps(over: Partial<NotifyDeps> = {}): NotifyDeps & { written: NotificationRow[] } {
    const written: NotificationRow[] = [];
    return {
      directory: { listEveryone: vi.fn().mockResolvedValue(["a@example.com", "b@example.com"]), listAdmins: vi.fn().mockResolvedValue(["a@example.com"]) },
      writer: { putAll: vi.fn(async (rows: NotificationRow[]) => { written.push(...rows); }) },
      now: () => NOW, newId: () => "id-1", written, ...over,
    };
  }
  it("resolves 'everyone', 'admins', and explicit lists", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events = () => log.mock.calls.map((c) => JSON.parse(String(c[0])));
    const d = deps();
    expect(await notify("books_added", { count: 1, bookIds: ["a"] }, "everyone", d)).toBe(2);
    expect(await notify("suggestion_pending", { suggestionId: "s", name: "N", suggestedBy: "b@example.com" }, "admins", d)).toBe(1);
    expect(await notify("suggestion_resolved", { suggestionId: "s", name: "N", status: "accepted", resolvedBy: "a@example.com" }, ["b@example.com"], d)).toBe(1);
    expect(d.written.map((r) => r.pk)).toEqual(["USER#a@example.com", "USER#b@example.com", "USER#a@example.com", "USER#b@example.com"]);
    expect(events()).toContainEqual(expect.objectContaining({ event: "notification.fanout", type: "books_added", recipients: 2 }));
    log.mockRestore();
  });
  it("writes nothing and returns 0 when there are no recipients", async () => {
    const d = deps({ directory: { listEveryone: vi.fn().mockResolvedValue([]), listAdmins: vi.fn().mockResolvedValue([]) } });
    expect(await notify("category_created", { name: "X", createdBy: "a@example.com", source: "admin" }, "admins", d)).toBe(0);
    expect(d.writer.putAll).not.toHaveBeenCalled();
  });
});

describe("CognitoDirectory", () => {
  it("pages through ListUsers, keeps only enabled confirmed/external users, and caches for 60s", async () => {
    const pages = [
      { Users: [user("a@example.com"), user("b@example.com", "UNCONFIRMED"), user("c@example.com", "CONFIRMED", false)], PaginationToken: "t1" },
      { Users: [user("d@example.com", "CONFIRMED")] },
    ];
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListUsersCommand) return pages.shift();
      throw new Error("unexpected " + (cmd as { constructor: { name: string } }).constructor.name);
    });
    let t = 0;
    const dir = new CognitoDirectory({ send }, "pool-1", 60_000, () => t);
    expect(await dir.listEveryone()).toEqual(["a@example.com", "d@example.com"]);
    expect((send.mock.calls[0][0] as ListUsersCommand).input).toEqual({ UserPoolId: "pool-1", Limit: 60 });
    expect((send.mock.calls[1][0] as ListUsersCommand).input.PaginationToken).toBe("t1");
    t = 30_000;
    expect(await dir.listEveryone()).toEqual(["a@example.com", "d@example.com"]);
    expect(send).toHaveBeenCalledTimes(2); // cached
    pages.push({ Users: [user("z@example.com")] });
    t = 61_000;
    expect(await dir.listEveryone()).toEqual(["z@example.com"]);
  });
  it("lists admins via ListUsersInGroup with NextToken paging", async () => {
    const pages = [{ Users: [user("a@example.com")], NextToken: "n" }, { Users: [user("b@example.com")] }];
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListUsersInGroupCommand) return pages.shift();
      throw new Error("unexpected");
    });
    const dir = new CognitoDirectory({ send }, "pool-1");
    expect(await dir.listAdmins()).toEqual(["a@example.com", "b@example.com"]);
    expect((send.mock.calls[0][0] as ListUsersInGroupCommand).input).toEqual({ UserPoolId: "pool-1", GroupName: "admins", Limit: 60 });
    expect((send.mock.calls[1][0] as ListUsersInGroupCommand).input.NextToken).toBe("n");
  });
});

describe("DynamoNotificationWriter", () => {
  it("batches 25 rows per BatchWrite and retries unprocessed items once", async () => {
    const rows = buildRows("books_added", { count: 1, bookIds: ["a"] }, Array.from({ length: 30 }, (_, i) => `u${i}@example.com`), NOW, () => "id");
    let call = 0;
    const send = vi.fn(async (cmd: unknown) => {
      call += 1;
      const req = (cmd as BatchWriteCommand).input.RequestItems!["T"];
      if (call === 1) return { UnprocessedItems: { T: req.slice(0, 1) } };
      return { UnprocessedItems: {} };
    });
    await new DynamoNotificationWriter({ send } as unknown as DynamoDBDocumentClient, "T").putAll(rows);
    expect(send).toHaveBeenCalledTimes(3); // 25, 5, retry of 1
    const first = send.mock.calls[0][0] as BatchWriteCommand;
    expect(first).toBeInstanceOf(BatchWriteCommand);
    expect(first.input.RequestItems!["T"]).toHaveLength(25);
    expect(first.input.RequestItems!["T"][0]).toEqual({ PutRequest: { Item: rows[0] } });
  });
  it("gives up after one retry with an error naming the count", async () => {
    const rows = buildRows("books_added", { count: 1, bookIds: ["a"] }, ["a@example.com"], NOW, () => "id");
    const send = vi.fn(async (cmd: unknown) => ({ UnprocessedItems: { T: (cmd as BatchWriteCommand).input.RequestItems!["T"] } }));
    await expect(new DynamoNotificationWriter({ send } as unknown as DynamoDBDocumentClient, "T").putAll(rows)).rejects.toThrow(/1 notification/);
  });
});
