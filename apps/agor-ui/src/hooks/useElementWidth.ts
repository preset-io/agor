/**
 * useElementWidth — the referenced element's `clientWidth`, kept current with a
 * ResizeObserver. Measured before paint; 0 until the element has been measured.
 */
import { type RefObject, useLayoutEffect, useState } from 'react';

export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
