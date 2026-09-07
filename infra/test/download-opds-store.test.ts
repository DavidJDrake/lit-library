import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoOpdsTokenStore } from "../lambda/download/opds-store";
import { hashOpdsToken } from "../lambda/shared/opds-token";

function client(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { ddb: { send } as unknown as DynamoDBDocumentClient, send };
}

describe("DynamoOpdsTokenStore", () => {
  it("hashes the token and looks it up by its OPDSTOKEN# key, doing only a GetItem", async () => {
    const token = "a-real-token";
    const hash = hashOpdsToken(token);
    const { ddb, send } = client(() => ({ Item: { email: "reader@example.com" } }));
    const email = await new DynamoOpdsTokenStore(ddb, "T").resolveToken(token);
    expect(email).toBe("reader@example.com");
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input).toEqual({ TableName: "T", Key: { pk: `OPDSTOKEN#${hash}`, sk: "TOKEN" } });
  });

  it("resolves undefined for a token with no matching row, without leaking why", async () => {
    const { ddb } = client(() => ({}));
    expect(await new DynamoOpdsTokenStore(ddb, "T").resolveToken("nope")).toBeUndefined();
  });

  it("rejects a malformed token before ever touching the table", async () => {
    const { ddb, send } = client(() => ({ Item: { email: "reader@example.com" } }));
    expect(await new DynamoOpdsTokenStore(ddb, "T").resolveToken("has spaces")).toBeUndefined();
    expect(await new DynamoOpdsTokenStore(ddb, "T").resolveToken("")).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves undefined when the stored row has no usable email", async () => {
    const { ddb } = client(() => ({ Item: { email: 42 } }));
    expect(await new DynamoOpdsTokenStore(ddb, "T").resolveToken("a-real-token")).toBeUndefined();
  });
});
