import { describe, expect, it } from 'vitest';
import { getAutocompletePopoverOffset } from './popoverPosition';

const base = {
  textareaRect: { left: 100, top: 100, bottom: 200 },
  caret: { left: 40, top: 20, lineHeight: 20 },
  textareaScrollLeft: 0,
  textareaScrollTop: 0,
  textareaOffsetHeight: 100,
  viewportWidth: 1000,
  viewportHeight: 800,
  popoverWidth: 320,
  popoverMaxHeight: 300,
  viewportMargin: 8,
};

describe('getAutocompletePopoverOffset', () => {
  it('keeps the normal caret-aligned position when there is room', () => {
    expect(getAutocompletePopoverOffset(base)).toEqual([40, -60]);
  });

  it('clamps horizontally when caret alignment would overflow the right viewport edge', () => {
    const offset = getAutocompletePopoverOffset({
      ...base,
      textareaRect: { left: 700, top: 100, bottom: 200 },
      caret: { left: 260, top: 20, lineHeight: 20 },
    });

    // Popup left is textarea left + offset x = 672, so 672 + 320 + 8 = 1000.
    expect(offset).toEqual([-28, -60]);
  });

  it('clamps horizontally when the textarea starts beyond the left viewport margin', () => {
    const offset = getAutocompletePopoverOffset({
      ...base,
      textareaRect: { left: -20, top: 100, bottom: 200 },
      caret: { left: 0, top: 20, lineHeight: 20 },
    });

    expect(offset[0]).toBe(28);
  });

  it('clamps vertically near the bottom viewport edge', () => {
    const offset = getAutocompletePopoverOffset({
      ...base,
      textareaRect: { left: 100, top: 680, bottom: 780 },
      caret: { left: 40, top: 80, lineHeight: 20 },
      viewportHeight: 800,
    });

    // Popup top is textarea bottom + offset y = 492, so 492 + 300 + 8 = 800.
    expect(offset).toEqual([40, -288]);
  });
});
