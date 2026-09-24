import { describe, expect, it } from 'vitest';
import { placeFlippingPopup } from './flippingPopup';

const VIEWPORT = { width: 1000, height: 800 };
const POPUP = { width: 340, height: 300 };
const GAP = 8;

// A footer chip: 22px tall, near the left edge of its panel.
const chipAt = (top: number, left = 40) => ({ top, left, width: 60, height: 22 });

describe('placeFlippingPopup', () => {
  it('opens above the trigger when there is room', () => {
    expect(placeFlippingPopup(chipAt(700), POPUP, VIEWPORT, GAP).top).toBe(700 - GAP - 300);
  });

  it('flips below the trigger when it does not fit above', () => {
    expect(placeFlippingPopup(chipAt(100), POPUP, VIEWPORT, GAP).top).toBe(100 + 22 + GAP);
  });

  it('keeps the roomier side and stays on screen when it fits neither', () => {
    // 400px viewport: 200 above the chip, ~178 below — above wins, clamped to 0.
    const shortViewport = { width: 1000, height: 400 };
    expect(placeFlippingPopup(chipAt(200), POPUP, shortViewport, GAP)).toMatchObject({ top: 0 });

    // Mirror image: the chip sits higher, so below is the roomier side and
    // the popup is pulled up just enough to keep its bottom on screen.
    const low = placeFlippingPopup(chipAt(100), POPUP, shortViewport, GAP);
    expect(low.top).toBe(shortViewport.height - POPUP.height);
  });

  it('left-aligns to the trigger', () => {
    expect(placeFlippingPopup(chipAt(700, 120), POPUP, VIEWPORT, GAP).left).toBe(120);
  });

  it('pulls a popup that would overhang the right edge back into view', () => {
    expect(placeFlippingPopup(chipAt(700, 900), POPUP, VIEWPORT, GAP).left).toBe(1000 - 340);
  });

  it('never positions off the top-left when the viewport is smaller than the popup', () => {
    const phone = { width: 320, height: 240 };
    expect(placeFlippingPopup(chipAt(200, 10), POPUP, phone, GAP)).toEqual({ top: 0, left: 0 });
  });
});
