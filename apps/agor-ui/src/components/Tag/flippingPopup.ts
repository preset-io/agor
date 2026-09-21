import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';

/** The parts of a `DOMRect` this module reads. */
export interface PopupBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface PopupSize {
  width: number;
  height: number;
}

export interface PopupPosition {
  top: number;
  left: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Viewport coordinates for a popup that opens above its trigger, flips below
 * when it does not fit above, and clamps into view when it fits on neither
 * side. Left-aligned to the trigger, clamped to the viewport's width.
 *
 * This is the hand-rolled counterpart to AntD's `autoAdjustOverflow`, for the
 * rare popup that cannot be an AntD overlay — see {@link TagPopover} for the
 * ordinary chip popover.
 */
export function placeFlippingPopup(
  trigger: PopupBox,
  popup: PopupSize,
  viewport: PopupSize,
  gap: number
): PopupPosition {
  const above = trigger.top - gap - popup.height;
  const below = trigger.top + trigger.height + gap;
  const roomAbove = trigger.top - gap;
  const roomBelow = viewport.height - below;
  // Prefer above; when neither side fits, take the roomier one and clamp.
  const useAbove = above >= 0 || (popup.height > roomBelow && roomAbove >= roomBelow);
  return {
    top: clamp(useAbove ? above : below, 0, viewport.height - popup.height),
    left: clamp(trigger.left, 0, viewport.width - popup.width),
  };
}

/**
 * Keeps a `position: fixed` popup placed against its trigger while it is open,
 * following scrolls and viewport resizes. Returns `null` until the popup has
 * been measured, which is the caller's cue to keep it out of view.
 */
export function useFlippingPopupPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
  gap: number
): PopupPosition | null {
  const [position, setPosition] = useState<PopupPosition | null>(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const next = placeFlippingPopup(
      trigger.getBoundingClientRect(),
      popup.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      gap
    );
    setPosition((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  }, [gap, popupRef, triggerRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
    // Capture: an ancestor scrolling moves the trigger without a window scroll.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    // A popup that grows after opening (a row added, a message shown) has to
    // re-place, or it would grow past the trigger it opened away from.
    const popup = popupRef.current;
    const observer = popup && new ResizeObserver(reposition);
    if (popup && observer) observer.observe(popup);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      if (observer) observer.disconnect();
    };
  }, [open, reposition, popupRef]);

  return position;
}
