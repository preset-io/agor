export const AUTOCOMPLETE_POPOVER_VIEWPORT_MARGIN = 8;
export const AUTOCOMPLETE_POPOVER_WIDTH = 320;
export const AUTOCOMPLETE_POPOVER_MAX_HEIGHT = 300;

interface RectLike {
  left: number;
  top: number;
  bottom: number;
}

export interface CaretCoordinates {
  left: number;
  top: number;
  lineHeight: number;
}

interface AutocompletePopoverOffsetOptions {
  textareaRect: RectLike;
  caret: CaretCoordinates;
  textareaScrollLeft: number;
  textareaScrollTop: number;
  textareaOffsetHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  popoverWidth?: number;
  popoverMaxHeight?: number;
  viewportMargin?: number;
}

const clamp = (value: number, min: number, max: number): number => {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
};

/**
 * Compute the Ant Design Popover `align.offset` that places autocomplete close
 * to the trigger caret while keeping the popup inside the viewport. The popover
 * is rendered with `bottomLeft` placement, so the popup's top-left is the
 * textarea wrapper's bottom-left plus this offset.
 */
export function getAutocompletePopoverOffset({
  textareaRect,
  caret,
  textareaScrollLeft,
  textareaScrollTop,
  textareaOffsetHeight,
  viewportWidth,
  viewportHeight,
  popoverWidth = AUTOCOMPLETE_POPOVER_WIDTH,
  popoverMaxHeight = AUTOCOMPLETE_POPOVER_MAX_HEIGHT,
  viewportMargin = AUTOCOMPLETE_POPOVER_VIEWPORT_MARGIN,
}: AutocompletePopoverOffsetOptions): [number, number] {
  const rawOffsetX = Math.max(0, caret.left - textareaScrollLeft);
  const rawOffsetY = caret.top + caret.lineHeight - textareaScrollTop - textareaOffsetHeight;

  const effectivePopoverWidth = Math.max(
    0,
    Math.min(popoverWidth, viewportWidth - viewportMargin * 2)
  );
  const effectivePopoverHeight = Math.max(
    0,
    Math.min(popoverMaxHeight, viewportHeight - viewportMargin * 2)
  );

  const rawPopupLeft = textareaRect.left + rawOffsetX;
  const rawPopupTop = textareaRect.bottom + rawOffsetY;

  const clampedPopupLeft = clamp(
    rawPopupLeft,
    viewportMargin,
    viewportWidth - viewportMargin - effectivePopoverWidth
  );
  const clampedPopupTop = clamp(
    rawPopupTop,
    viewportMargin,
    viewportHeight - viewportMargin - effectivePopoverHeight
  );

  return [clampedPopupLeft - textareaRect.left, clampedPopupTop - textareaRect.bottom];
}
