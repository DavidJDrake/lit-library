// Pure windowing arithmetic for a uniform-column CSS grid (see Library.tsx's `.grid`).
//
// The grid has no explicit row template, so the DOM is the source of truth for the
// column count and row height; this module only turns those measurements plus a
// scroll position into "which items to render" and "how much space to reserve above
// and below them so the scrollbar still reflects the whole list". Kept free of the
// DOM so it can be tested directly, without faking layout.

export interface WindowInput {
  /** How far the grid has scrolled past its own top edge, in px. Negative values
   *  (grid not yet reached) are treated as 0. */
  scrollOffset: number;
  /** Height of the viewport the grid is scrolled within, in px. */
  viewportHeight: number;
  /** Height of one grid row (cards + row gap), in px, as measured from a rendered card. */
  rowHeight: number;
  /** Number of columns the grid is currently laying out, as measured from the DOM. */
  columnCount: number;
  /** Total number of items in the list being windowed. */
  itemCount: number;
  /** Extra rows to render beyond each edge of the viewport. Defaults to 2. */
  overscanRows?: number;
}

export interface WindowResult {
  /** Index of the first item to render (inclusive). */
  startIndex: number;
  /** Index of the last item to render (exclusive). */
  endIndex: number;
  /** Height, in px, of the spacer to reserve above the rendered items. */
  topSpacer: number;
  /** Height, in px, of the spacer to reserve below the rendered items. */
  bottomSpacer: number;
}

const DEFAULT_OVERSCAN_ROWS = 2;

/**
 * Given a scroll position and the grid's real (measured) geometry, decide which
 * item range to render and how much space to reserve for the rows skipped above
 * and below it.
 *
 * Falls back to "render everything, no spacers" for degenerate input (no items,
 * no columns, or a non-positive row height) rather than producing NaN/Infinity —
 * callers that lack a real measurement should prefer not to call this at all
 * (see the degrade path in Library.tsx), but this keeps the function itself total.
 */
export function computeWindow(input: WindowInput): WindowResult {
  const { itemCount, columnCount, rowHeight, viewportHeight } = input;
  const overscanRows = input.overscanRows ?? DEFAULT_OVERSCAN_ROWS;

  if (itemCount <= 0) return { startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0 };
  if (columnCount < 1 || rowHeight <= 0) return { startIndex: 0, endIndex: itemCount, topSpacer: 0, bottomSpacer: 0 };

  const totalRows = Math.ceil(itemCount / columnCount);
  const scrollOffset = Math.max(0, input.scrollOffset);
  const viewport = Math.max(0, viewportHeight);

  const firstVisibleRow = Math.floor(scrollOffset / rowHeight);
  const lastVisibleRow = Math.floor((scrollOffset + viewport) / rowHeight);

  const startRow = Math.max(0, firstVisibleRow - overscanRows);
  const endRow = Math.min(totalRows - 1, lastVisibleRow + overscanRows);

  const startIndex = startRow * columnCount;
  const endIndex = Math.min(itemCount, (endRow + 1) * columnCount);
  const topSpacer = startRow * rowHeight;
  const bottomSpacer = Math.max(0, (totalRows - endRow - 1) * rowHeight);

  return { startIndex, endIndex, topSpacer, bottomSpacer };
}
