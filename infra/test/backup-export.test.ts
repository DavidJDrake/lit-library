import { describe, expect, it, vi } from "vitest";
import { exportTables, scanAll, stamp, type ScanFn } from "../lambda/backup/export";

const AT = new Date("2026-09-12T01:45:30.000Z");

describe("stamp", () => {
  it("matches the shell script's date -u +%Y-%m-%dT%H%M%SZ format", () => {
    expect(stamp(AT)).toBe("2026-09-12T014530Z");
  });
});

describe("scanAll", () => {
  it("follows LastEvaluatedKey until the table is exhausted", async () => {
    const pages = [
      { Items: [{ pk: "a" }], LastEvaluatedKey: { pk: "a" } },
      { Items: [{ pk: "b" }], LastEvaluatedKey: { pk: "b" } },
      { Items: [{ pk: "c" }] },
    ];
    const seen: (Record<string, unknown> | undefined)[] = [];
    const scan: ScanFn = async (_table, startKey) => {
      seen.push(startKey);
      return pages[seen.length - 1];
    };
    await expect(scanAll(scan, "T")).resolves.toEqual([{ pk: "a" }, { pk: "b" }, { pk: "c" }]);
    expect(seen).toEqual([undefined, { pk: "a" }, { pk: "b" }]);
  });
});

describe("exportTables", () => {
  it("writes one stamped object per table in the same shape as `aws dynamodb scan`", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const scan: ScanFn = async (table) => ({ Items: table === "lib" ? [{ pk: "x" }, { pk: "y" }] : [{ pk: "z" }] });
    const counts = await exportTables(
      [{ table: "lib", name: "library" }, { table: "dl", name: "downloads" }],
      { scan, put, now: () => AT },
    );
    expect(counts).toEqual({ library: 2, downloads: 1 });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith("dynamodb/library-2026-09-12T014530Z.json",
      JSON.stringify({ Items: [{ pk: "x" }, { pk: "y" }], Count: 2 }));
    expect(put).toHaveBeenCalledWith("dynamodb/downloads-2026-09-12T014530Z.json",
      JSON.stringify({ Items: [{ pk: "z" }], Count: 1 }));
  });

  it("propagates a failed scan instead of reporting success", async () => {
    const scan: ScanFn = async () => { throw new Error("ddb down"); };
    await expect(exportTables([{ table: "lib", name: "library" }],
      { scan, put: vi.fn(), now: () => AT })).rejects.toThrow("ddb down");
  });

  it("propagates a failed put instead of reporting success", async () => {
    const scan: ScanFn = async () => ({ Items: [] });
    const put = vi.fn().mockRejectedValue(new Error("no such bucket"));
    await expect(exportTables([{ table: "lib", name: "library" }],
      { scan, put, now: () => AT })).rejects.toThrow("no such bucket");
  });
});
