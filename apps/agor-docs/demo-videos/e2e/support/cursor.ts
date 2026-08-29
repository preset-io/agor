// Headless Chromium never paints an OS cursor icon for Playwright's
// synthetic page.mouse.move() calls (a well-known Playwright limitation —
// confirmed empirically: page.mouse.move() + screenshot renders nothing).
// This injects a JS-drawn cursor that follows the real 'mousemove' DOM
// events page.mouse.move() genuinely dispatches (CDP Input.dispatchMouseEvent
// produces trusted events the page can listen to).
//
// Inject via page.evaluate() AFTER navigation, not page.addInitScript() +
// page.setContent() — addInitScript's evaluateOnNewDocument did not fire for
// setContent-loaded content in testing. A real page.goto() navigation should
// support addInitScript correctly, but evaluate-after-load is what's proven
// to work here, so every helper in this file uses that.

import type { Locator, Page } from '@playwright/test';

const CURSOR_ID = '__pw_cursor';

const CURSOR_SVG =
  '<svg width="28" height="28" viewBox="0 0 28 28" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))">' +
  '<path d="M4 2 L4 22 L9.5 17.5 L13 25 L16.5 23.5 L13 16 L20 16 Z" ' +
  'fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>';

/** Inject the fake cursor overlay. Safe to call again after a navigation. */
export async function installCursor(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, svg }) => {
      if (document.getElementById(id)) return;
      const cursor = document.createElement('div');
      cursor.id = id;
      cursor.style.cssText = [
        'position:fixed',
        'z-index:2147483647',
        'pointer-events:none',
        'left:0',
        'top:0',
        'width:0',
        'height:0',
        'will-change:transform',
      ].join(';');
      cursor.innerHTML = svg;
      document.documentElement.appendChild(cursor);
      window.addEventListener(
        'mousemove',
        (e) => {
          cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
        },
        true
      );
    },
    { id: CURSOR_ID, svg: CURSOR_SVG }
  );
}

/** Move the real Playwright mouse to an element's center, eased over `steps`. */
export async function moveToElement(page: Page, locator: Locator, steps = 20): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('moveToElement: target has no bounding box (not visible?)');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
}
