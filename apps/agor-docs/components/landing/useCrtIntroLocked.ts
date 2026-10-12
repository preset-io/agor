import { useEffect, useState } from 'react';
import { CRT_INTRO_ATTR, crtIntroState } from '../../lib/crtIntro';

/** Whether the CRT intro is still covering the page. */
export function useCrtIntroLocked(): boolean {
  const [locked, setLocked] = useState(() => crtIntroState() === 'locked');
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setLocked(root.getAttribute(CRT_INTRO_ATTR) === 'locked');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: [CRT_INTRO_ATTR] });
    return () => observer.disconnect();
  }, []);
  return locked;
}
