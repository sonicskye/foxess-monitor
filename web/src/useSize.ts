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
export function useSize<T extends HTMLElement>(): [RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setSize((previous) =>
        Math.abs(previous.width - rect.width) < 1 && Math.abs(previous.height - rect.height) < 1
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
