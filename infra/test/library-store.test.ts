import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoStore } from "../lambda/library/store";

const NOW = "2026-09-04T12:00:00.000Z";

function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}
function conditionalFailure() {
  const e = new Error("cond") as Error & { name: string };
  e.name = "ConditionalCheckFailedException";
  return e;
}
// Defaults to a genuine condition failure (one reason with Code: ConditionalCheckFailed),
// matching what a lost race actually looks like on the wire. Pass other reason codes to
// simulate a cancellation that was NOT a failed condition (conflict, throttling, etc).
function transactionCancelled(reasons: Array<{ Code?: string }> = [{ Code: "ConditionalCheckFailed" }]) {
  const e = new Error("cancelled") as Error & { name: string; CancellationReasons?: Array<{ Code?: string }> };
  e.name = "TransactionCanceledException";
  e.CancellationReasons = reasons;
  return e;
}

describe("DynamoStore reads", () => {
  it("lists categories by pk and follows pagination", async () => {
    const pages = [
      { Items: [{ pk: "CATEGORY", sk: "Fiction", nameLower: "fiction", createdBy: "seed", createdAt: NOW, source: "seed" }], LastEvaluatedKey: { pk: "CATEGORY", sk: "Fiction" } },
      { Items: [{ pk: "CATEGORY", sk: "Comics", nameLower: "comics", createdBy: "seed", createdAt: NOW, source: "seed" }] },
    ];
    const { ddb, send } = client(() => pages.shift());
    const out = await new DynamoStore(ddb, "T").listCategories();
    expect(out.map((c) => c.name)).toEqual(["Fiction", "Comics"]);
    const first = send.mock.calls[0][0] as QueryCommand;
    expect(first).toBeInstanceOf(QueryCommand);
    expect(first.input).toMatchObject({ TableName: "T", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "CATEGORY" } });
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({ pk: "CATEGORY", sk: "Fiction" });
  });
  it("maps book and suggestion items and filters suggestions to pending", async () => {
    const { ddb } = client((cmd) => {
      const pk = (cmd as QueryCommand).input.ExpressionAttributeValues?.[":pk"];
      if (pk === "BOOK") return { Items: [{ pk, sk: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW }] };
      return { Items: [
        { pk, sk: "s1", name: "Cookbooks", nameLower: "cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW, status: "pending" },
        { pk, sk: "s0", name: "Old", nameLower: "old", suggestedBy: "z@x", createdAt: NOW, status: "rejected", resolvedBy: "a@x", resolvedAt: NOW },
      ] };
    });
    const store = new DynamoStore(ddb, "T");
    expect(await store.listBookCategories()).toEqual([{ bookId: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW }]);
    const pending = await store.listPendingSuggestions();
    expect(pending).toEqual([{ id: "s1", name: "Cookbooks", nameLower: "cookbooks", bookId: "b1", suggestedBy: "z@x", createdAt: NOW, status: "pending" }]);
    expect((await store.listPendingSuggestions())[0]).not.toHaveProperty("resolvedBy");
  });
  it("gets one suggestion by id, undefined when missing", async () => {
    const { ddb, send } = client((cmd) => ((cmd as GetCommand).input.Key?.sk === "s1"
      ? { Item: { pk: "SUGGESTION", sk: "s1", name: "X", nameLower: "x", suggestedBy: "z@x", createdAt: NOW, status: "pending" } }
      : {}));
    const store = new DynamoStore(ddb, "T");
    expect((await store.getSuggestion("s1"))?.id).toBe("s1");
    expect(await store.getSuggestion("nope")).toBeUndefined();
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });
});

describe("DynamoStore writes", () => {
  it("putCategory is a conditional put and reports a duplicate as false", async () => {
    const { ddb, send } = client(() => ({}));
    const ok = await new DynamoStore(ddb, "T").putCategory({ name: "X", nameLower: "x", createdBy: "a@x", createdAt: NOW, source: "admin" });
    expect(ok).toBe(true);
    const cmd = send.mock.calls[0][0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input).toEqual({
      TableName: "T", ConditionExpression: "attribute_not_exists(pk)",
      Item: { pk: "CATEGORY", sk: "X", nameLower: "x", createdBy: "a@x", createdAt: NOW, source: "admin" },
    });
    const dup = client(() => { throw conditionalFailure(); });
    expect(await new DynamoStore(dup.ddb, "T").putCategory({ name: "X", nameLower: "x", createdBy: "a@x", createdAt: NOW, source: "admin" })).toBe(false);
  });
  it("putBookCategory writes the expected item", async () => {
    const { ddb, send } = client(() => ({}));
    const store = new DynamoStore(ddb, "T");
    await store.putBookCategory({ bookId: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW });
    expect((send.mock.calls[0][0] as PutCommand).input.Item).toEqual({ pk: "BOOK", sk: "b1", category: "Fiction", changedBy: "u@x", changedAt: NOW });
  });
  it("putSuggestion is one transaction: suggestion put and a conditional name reservation", async () => {
    const { ddb, send } = client(() => ({}));
    const ok = await new DynamoStore(ddb, "T").putSuggestion({ id: "s1", name: "C", nameLower: "c", suggestedBy: "u@x", createdAt: NOW, status: "pending" });
    expect(ok).toBe(true);
    const cmd = send.mock.calls[0][0] as TransactWriteCommand;
    expect(cmd).toBeInstanceOf(TransactWriteCommand);
    expect(cmd.input.TransactItems).toEqual([
      { Put: { TableName: "T", Item: { pk: "SUGGESTION", sk: "s1", name: "C", nameLower: "c", suggestedBy: "u@x", createdAt: NOW, status: "pending" } } },
      { Put: { TableName: "T", Item: { pk: "SUGGESTION_NAME", sk: "c" }, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
  });
  it("putSuggestion returns false, not a throw, when the name is already reserved", async () => {
    const taken = client(() => { throw transactionCancelled(); });
    expect(await new DynamoStore(taken.ddb, "T").putSuggestion({ id: "s1", name: "C", nameLower: "c", suggestedBy: "u@x", createdAt: NOW, status: "pending" })).toBe(false);
  });
  it("putSuggestion rethrows a cancellation that was not a failed condition (conflict, throttling, ...)", async () => {
    const conflict = client(() => { throw transactionCancelled([{ Code: "None" }, { Code: "TransactionConflict" }]); });
    await expect(new DynamoStore(conflict.ddb, "T").putSuggestion({ id: "s1", name: "C", nameLower: "c", suggestedBy: "u@x", createdAt: NOW, status: "pending" })).rejects.toThrow("cancelled");
    const throttled = client(() => { throw transactionCancelled([{ Code: "ThrottlingError" }, { Code: "None" }]); });
    await expect(new DynamoStore(throttled.ddb, "T").putSuggestion({ id: "s1", name: "C", nameLower: "c", suggestedBy: "u@x", createdAt: NOW, status: "pending" })).rejects.toThrow("cancelled");
  });
  it("acceptSuggestion is one transaction: conditional category put, book put, guarded status update", async () => {
    const { ddb, send } = client(() => ({}));
    const ok = await new DynamoStore(ddb, "T").acceptSuggestion(
      "s1",
      { name: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" },
      { bookId: "b1", category: "C", changedBy: "a@x", changedAt: NOW },
      "a@x", NOW,
    );
    expect(ok).toBe(true);
    const cmd = send.mock.calls[0][0] as TransactWriteCommand;
    expect(cmd).toBeInstanceOf(TransactWriteCommand);
    expect(cmd.input.TransactItems).toEqual([
      { Put: { TableName: "T", ConditionExpression: "attribute_not_exists(pk)",
        Item: { pk: "CATEGORY", sk: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" } } },
      { Put: { TableName: "T", Item: { pk: "BOOK", sk: "b1", category: "C", changedBy: "a@x", changedAt: NOW } } },
      { Update: { TableName: "T", Key: { pk: "SUGGESTION", sk: "s1" },
        UpdateExpression: "SET #status = :accepted, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":accepted": "accepted", ":pending": "pending", ":by": "a@x", ":at": NOW } } },
      { Delete: { TableName: "T", Key: { pk: "SUGGESTION_NAME", sk: "c" } } },
    ]);
  });
  it("acceptSuggestion without a book has three items (no book put), and a cancelled transaction returns false", async () => {
    const { ddb, send } = client(() => ({}));
    await new DynamoStore(ddb, "T").acceptSuggestion("s1", { name: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" }, undefined, "a@x", NOW);
    expect((send.mock.calls[0][0] as TransactWriteCommand).input.TransactItems).toHaveLength(3);
    const lost = client(() => { throw transactionCancelled(); });
    expect(await new DynamoStore(lost.ddb, "T").acceptSuggestion("s1", { name: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" }, undefined, "a@x", NOW)).toBe(false);
  });
  it("acceptSuggestion rethrows a cancellation that was not a failed condition", async () => {
    const conflict = client(() => { throw transactionCancelled([{ Code: "None" }, { Code: "TransactionConflict" }, { Code: "None" }]); });
    await expect(new DynamoStore(conflict.ddb, "T").acceptSuggestion("s1", { name: "C", nameLower: "c", createdBy: "a@x", createdAt: NOW, source: "suggestion" }, undefined, "a@x", NOW)).rejects.toThrow("cancelled");
  });
  it("rejectSuggestion is one transaction: guarded update plus name-reservation release; false when not pending", async () => {
    const { ddb, send } = client(() => ({}));
    expect(await new DynamoStore(ddb, "T").rejectSuggestion("s1", "c", "a@x", NOW)).toBe(true);
    const cmd = send.mock.calls[0][0] as TransactWriteCommand;
    expect(cmd).toBeInstanceOf(TransactWriteCommand);
    expect(cmd.input.TransactItems).toEqual([
      { Update: { TableName: "T", Key: { pk: "SUGGESTION", sk: "s1" },
        UpdateExpression: "SET #status = :rejected, resolvedBy = :by, resolvedAt = :at",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":rejected": "rejected", ":pending": "pending", ":by": "a@x", ":at": NOW } } },
      { Delete: { TableName: "T", Key: { pk: "SUGGESTION_NAME", sk: "c" } } },
    ]);
    const done = client(() => { throw transactionCancelled(); });
    expect(await new DynamoStore(done.ddb, "T").rejectSuggestion("s1", "c", "a@x", NOW)).toBe(false);
  });
  it("rejectSuggestion rethrows a cancellation that was not a failed condition", async () => {
    const throttled = client(() => { throw transactionCancelled([{ Code: "ThrottlingError" }, { Code: "None" }]); });
    await expect(new DynamoStore(throttled.ddb, "T").rejectSuggestion("s1", "c", "a@x", NOW)).rejects.toThrow("cancelled");
  });
  it("rethrows unexpected errors", async () => {
    const { ddb } = client(() => { throw new Error("network"); });
    await expect(new DynamoStore(ddb, "T").listCategories()).rejects.toThrow("network");
    await expect(new DynamoStore(ddb, "T").rejectSuggestion("s1", "c", "a@x", NOW)).rejects.toThrow("network");
  });
});
