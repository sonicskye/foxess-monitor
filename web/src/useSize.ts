import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

/**
 * Observe an element's pixel size.
 *
 * The charts draw in real pixels rather than a fixed viewBox scaled with
 * `preserveAspectRatio="none"`. Non-uniform scaling stretches the text and strokes along with the
 * geometry — tick labels come out visibly wide — and an SVG with a viewBox also derives its
 * intrinsic height from that ratio, so it overflows a flex container instead of filling it.
 * Measuring and drawing at true size avoids both.
 */
export interface Size {
  width: number;
  height: number;
  /**
   * The current root font size in px.
   *
   * Reported alongside the box because a chart that draws in real pixels needs its padding to track
   * the fluid type scale; otherwise its own labels outgrow the space reserved for them.
   */
  rootFontSize: number;
}

function rootFontSize(): number {
  const parsed = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

export function useSize<T extends HTMLElement>(): [RefObject<T>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0, rootFontSize: 16 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      const root = rootFontSize();
      setSize((previous) =>
        Math.abs(previous.width - rect.width) < 1 &&
        Math.abs(previous.height - rect.height) < 1 &&
        previous.rootFontSize === root
          ? previous
          : { width: rect.width, height: rect.height, rootFontSize: root },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The root size is viewport-driven and changes with the manual zoom, neither of which resizes
    // this element on its own.
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return [ref, size];
}
