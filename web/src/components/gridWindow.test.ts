import { describe, expect, it } from "vitest";
import { computeWindow } from "./gridWindow";

// 100 items, 4 columns -> 25 rows of 300px, 900px (3 rows) of viewport, default
// overscan of 2 rows on each side.
const base = { rowHeight: 300, columnCount: 4, itemCount: 100, viewportHeight: 900 };

describe("computeWindow", () => {
  it("renders the first screen plus overscan, with no top spacer", () => {
    expect(computeWindow({ ...base, scrollOffset: 0 })).toEqual({
      startIndex: 0, endIndex: 24, topSpacer: 0, bottomSpacer: 5700,
    });
  });

  it("renders a middle screen with spacers on both sides", () => {
    expect(computeWindow({ ...base, scrollOffset: 3600 })).toEqual({
      startIndex: 40, endIndex: 72, topSpacer: 3000, bottomSpacer: 2100,
    });
  });

  it("renders the last screen plus overscan, with no bottom spacer", () => {
    // 25 rows * 300px - 900px viewport = 6600px of scrollable range.
    expect(computeWindow({ ...base, scrollOffset: 6600 })).toEqual({
      startIndex: 80, endIndex: 100, topSpacer: 6000, bottomSpacer: 0,
    });
  });

  it("renders everything for a list shorter than one screen, with no spacers", () => {
    expect(computeWindow({ ...base, itemCount: 6, scrollOffset: 0 })).toEqual({
      startIndex: 0, endIndex: 6, topSpacer: 0, bottomSpacer: 0,
    });
  });

  it("renders nothing for an empty list", () => {
    expect(computeWindow({ ...base, itemCount: 0, scrollOffset: 0 })).toEqual({
      startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0,
    });
  });

  it("clamps a negative scroll offset (e.g. rubber-banding) to 0", () => {
    expect(computeWindow({ ...base, scrollOffset: -400 })).toEqual(computeWindow({ ...base, scrollOffset: 0 }));
  });

  it("clamps the window to the last row rather than overscanning past the end", () => {
    // Scrolled to the very bottom of the range: the +overscan lookahead must not
    // push endRow (or the spacer math) past the real last row.
    const r = computeWindow({ ...base, scrollOffset: 7500 - 900 });
    expect(r.endIndex).toBe(100);
    expect(r.bottomSpacer).toBe(0);
  });

  it("honours a custom overscan", () => {
    expect(computeWindow({ ...base, scrollOffset: 3600, overscanRows: 0 })).toEqual({
      startIndex: 48, endIndex: 64, topSpacer: 3600, bottomSpacer: 2700,
    });
  });

  it("falls back to rendering everything when there are no columns (unmeasured)", () => {
    expect(computeWindow({ ...base, columnCount: 0, scrollOffset: 3600 })).toEqual({
      startIndex: 0, endIndex: 100, topSpacer: 0, bottomSpacer: 0,
    });
  });

  it("falls back to rendering everything when row height is zero or negative", () => {
    expect(computeWindow({ ...base, rowHeight: 0, scrollOffset: 3600 })).toEqual({
      startIndex: 0, endIndex: 100, topSpacer: 0, bottomSpacer: 0,
    });
    expect(computeWindow({ ...base, rowHeight: -10, scrollOffset: 3600 })).toEqual({
      startIndex: 0, endIndex: 100, topSpacer: 0, bottomSpacer: 0,
    });
  });

  it("still reserves a full row of spacer when a row is only partially filled", () => {
    // 10 items, 4 columns -> 3 rows (last row has 2 items); the reserved space
    // must be based on row count, not item count.
    const r = computeWindow({ rowHeight: 300, columnCount: 4, itemCount: 10, viewportHeight: 300, scrollOffset: 0 });
    // totalRows = 3, viewport covers row 0 only, overscan 2 pulls in all 3 rows.
    expect(r).toEqual({ startIndex: 0, endIndex: 10, topSpacer: 0, bottomSpacer: 0 });
  });
});
