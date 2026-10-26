import { useEffect, useState, type RefObject } from 'react';

/** Rows of a fixed height that are on screen (plus overscan) in a scrolling element. */
export function useVirtual(ref: RefObject<HTMLElement | null>, count: number, rowHeight: number, overscan = 12) {
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScroll(el.scrollTop));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    setScroll(el.scrollTop);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [ref]);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scroll + height) / rowHeight) + overscan);
  return { start, end, total: count * rowHeight, height };
}
