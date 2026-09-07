import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { computeWindow, type WindowResult } from "./gridWindow";

const OVERSCAN_ROWS = 2;

interface Geometry {
  columnCount: number;
  rowHeight: number;
}

interface Scroll {
  offset: number;
  viewportHeight: number;
}

export interface GridWindow {
  /** Ref for the element that wraps the top spacer, the grid and the bottom spacer.
   *  Its position never moves as spacers grow or shrink, so it is the stable anchor
   *  used to measure how far the reader has scrolled past the top of the whole list. */
  wrapperRef: RefObject<HTMLDivElement | null>;
  /** Ref for the `.grid` element itself, used to read its resolved column count and
   *  a rendered card's box. */
  gridRef: RefObject<HTMLDivElement | null>;
  /** The item range to render plus spacer heights, or null when no measurement is
   *  available yet (before layout, or when the environment has no ResizeObserver) —
   *  callers should render every item in that case. */
  range: WindowResult | null;
}

/**
 * Measures the real, rendered grid (its resolved column count from computed style,
 * and a row's height from a rendered card) and turns the current scroll position
 * into the item range that needs to render, so a long shelf does not mount every
 * card at once.
 *
 * Never invents a row height or column count: if the grid cannot be measured (no
 * `ResizeObserver`, or nothing has rendered yet) `range` stays null and the caller
 * is expected to fall back to rendering everything, exactly as before this hook
 * existed.
 */
export function useGridWindow(itemCount: number): GridWindow {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [scroll, setScroll] = useState<Scroll>({ offset: 0, viewportHeight: 0 });

  // Re-measure the grid's own geometry whenever its content could have changed shape
  // (item count changes) and whenever its box resizes (column count depends on
  // container width; a row's height can depend on how a title wrapped).
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") {
      setGeometry(null);
      return undefined;
    }

    const measure = () => {
      const style = getComputedStyle(grid);
      const columnCount = style.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
      const card = grid.querySelector<HTMLElement>(".card");
      const rowGap = parseFloat(style.rowGap) || 0;
      const rowHeight = card ? card.getBoundingClientRect().height + rowGap : 0;
      setGeometry(columnCount >= 1 && rowHeight > 0 ? { columnCount, rowHeight } : null);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [itemCount]);

  // Track scroll position relative to the wrapper's top, plus the viewport height.
  // Set up once: whether the environment can measure at all does not change at
  // runtime, so there is no need to tear this down and rebuild it as geometry updates.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;

    let raf = 0;
    const update = () => {
      raf = 0;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      setScroll({ offset: -wrapper.getBoundingClientRect().top, viewportHeight: window.innerHeight });
    };
    const onScrollOrResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, []);

  const range = geometry
    ? computeWindow({
        scrollOffset: scroll.offset,
        viewportHeight: scroll.viewportHeight,
        rowHeight: geometry.rowHeight,
        columnCount: geometry.columnCount,
        itemCount,
        overscanRows: OVERSCAN_ROWS,
      })
    : null;

  return { wrapperRef, gridRef, range };
}
