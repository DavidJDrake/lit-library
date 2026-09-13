import { describe, expect, it, vi } from "vitest";
import { makeDeps } from "../lambda/backup/index";

/**
 * Covers the real scan adapter built by `makeDeps` — the only place
 * ExclusiveStartKey/LastEvaluatedKey passthrough can be dropped. Nothing else
 * exercises this code: `backup-export.test.ts` only drives `exportTables`
 * against a hand-written `ScanFn`, never the client-dynamodb wiring.
 */
describe("makeDeps", () => {
  it("carries LastEvaluatedKey from one page as ExclusiveStartKey on the next, and puts all rows", async () => {
    const pages = [
      {
        Items: [{ pk: { S: "a" } }],
        LastEvaluatedKey: { pk: { S: "a" } },
      },
      {
        Items: [{ pk: { S: "b" } }],
      },
    ];
    const send = vi.fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1]);
    const ddb = { send };
    const put = vi.fn().mockResolvedValue(undefined);
    const s3 = { send: put };

    const deps = makeDeps(ddb as never, s3 as never, "my-bucket");

    const first = await deps.scan("T");
    expect(first).toEqual({ Items: [{ pk: { S: "a" } }], LastEvaluatedKey: { pk: { S: "a" } } });
    const second = await deps.scan("T", first.LastEvaluatedKey);
    expect(second).toEqual({ Items: [{ pk: { S: "b" } }], LastEvaluatedKey: undefined });

    expect(send).toHaveBeenCalledTimes(2);
    const secondCallInput = send.mock.calls[1][0].input;
    expect(secondCallInput.ExclusiveStartKey).toEqual(pages[0].LastEvaluatedKey);

    await deps.put("dynamodb/library-x.json", "body");
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ Bucket: "my-bucket", Key: "dynamodb/library-x.json", Body: "body" }),
    }));
  });
});
