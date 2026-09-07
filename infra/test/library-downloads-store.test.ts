import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDownloadsStore } from "../lambda/library/downloads";

function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}

describe("DynamoDownloadsStore", () => {
  it("queries by email and returns distinct book ids", async () => {
    const { ddb, send } = client(() => ({
      Items: [{ bookId: "b1" }, { bookId: "b2" }, { bookId: "b1" }],
    }));
    const ids = await new DynamoDownloadsStore(ddb, "T").listDownloadedBookIds("u@x");
    expect(ids).toEqual(["b1", "b2"]);
    const cmd = send.mock.calls[0][0] as QueryCommand;
    expect(cmd).toBeInstanceOf(QueryCommand);
    expect(cmd.input).toMatchObject({
      TableName: "T", KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: { ":email": "u@x" }, ProjectionExpression: "bookId",
    });
  });
  it("follows pagination, deduplicating across pages", async () => {
    const pages = [
      { Items: [{ bookId: "b1" }], LastEvaluatedKey: { email: "u@x", sk: "t1#b1" } },
      { Items: [{ bookId: "b1" }, { bookId: "b2" }] },
    ];
    const { ddb, send } = client(() => pages.shift());
    const ids = await new DynamoDownloadsStore(ddb, "T").listDownloadedBookIds("u@x");
    expect(ids).toEqual(["b1", "b2"]);
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual({ email: "u@x", sk: "t1#b1" });
  });
  it("a reader with no download history gets an empty array, not an error", async () => {
    const { ddb } = client(() => ({}));
    expect(await new DynamoDownloadsStore(ddb, "T").listDownloadedBookIds("nobody@x")).toEqual([]);
  });
});
