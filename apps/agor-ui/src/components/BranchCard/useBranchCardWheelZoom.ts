import { useEffect, useRef } from 'react';
import { REACT_FLOW_NO_WHEEL_CLASS } from '../../utils/reactFlowDragClasses';

/** Keep inner scrolling, but let the board own modifier-wheel / trackpad pinch. */
export function useBranchCardWheelZoom(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = ref.current;
    if (!enabled || !card) return;

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !(event.target instanceof Element)) return;
      const scrollArea = event.target.closest(`.${REACT_FLOW_NO_WHEEL_CLASS}`);
      if (!scrollArea || !card.contains(scrollArea)) return;
      const renderer = card.closest('.react-flow__renderer');
      if (!renderer) return; // Standalone cards must not suppress browser zoom.

      // Capture before rc-virtual-list's native listener scrolls the tree, even
      // with Ctrl/Meta held. React's delegated wheel listeners are passive, so
      // a React onWheel/onWheelCapture cannot reliably cancel browser pinch.
      event.preventDefault();
      event.stopPropagation();

      // Bypass only this card's nowheel subtree. Reuse React Flow's native
      // handler (pointer anchor, platform delta scaling, limits, move events)
      // rather than implementing a second zoom algorithm. Preserve modifiers:
      // Ctrl without keydown is pinch; Meta uses the board's activation keys.
      renderer.dispatchEvent(new WheelEvent(event.type, event));
    };

    card.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => card.removeEventListener('wheel', onWheel, { capture: true });
  }, [enabled]);

  return ref;
}
