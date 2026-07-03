/**
 * useInViewportOnce — true once the referenced element has intersected the
 * viewport. Used to keep heavy embeds (Sandpack artifact/app nodes) from
 * booting while offscreen — e.g. during a board navigation (#1768) — without
 * unmounting them again when the user scrolls away.
 */
import { type RefObject, useEffect, useState } from 'react';

export function useInViewportOnce(ref: RefObject<Element | null>, margin = '200px'): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: margin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen, ref, margin]);

  return seen;
}
