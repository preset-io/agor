// Framing the board canvas for a take. Agor fits the whole board on load,
// which leaves cards small; zoom in on just the zones a shot needs, so the
// capture itself is sharp (the edit's camera can only magnify pixels).
//
// The canvas is React Flow: Ctrl+wheel zooms about the pointer (scale
// x 2^(-deltaY * 0.02)) and a plain wheel pans (0.5 px per delta unit).
// Converge in a few steps rather than trusting those constants exactly.

import type { Locator, Page } from '@playwright/test';

const HEADER = 64;
/** The board's left rail (panel tabs and canvas tools). */
const RAIL = 110;

async function union(nodes: Locator[]) {
  const boxes = (await Promise.all(nodes.map((n) => n.boundingBox()))).filter(
    (b): b is NonNullable<typeof b> => b !== null
  );
  if (boxes.length === 0) throw new Error('frameNodes: nothing to frame is visible');
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.width));
  const b = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, w: r - x, h: b - y };
}

/**
 * Zoom and pan the canvas so `nodes` fill the view (inside `margin` px),
 * off camera, before a take's action starts.
 */
export async function frameNodes(
  page: Page,
  nodes: Locator[],
  options: { margin?: number; maxZoomSteps?: number } = {}
): Promise<void> {
  const margin = options.margin ?? 60;
  const view = page.viewportSize() ?? { width: 1920, height: 1080 };
  const target = {
    x: RAIL + margin,
    y: HEADER + margin,
    w: view.width - RAIL - 2 * margin,
    h: view.height - HEADER - 2 * margin,
  };
  // Zoom first (React Flow caps each Ctrl+wheel step at a few percent, so
  // step until the scale is right), then pan the center into place.
  for (let i = 0; i < (options.maxZoomSteps ?? 120); i++) {
    const box = await union(nodes);
    const scale = Math.min(target.w / box.w, target.h / box.h);
    if (Math.abs(Math.log(scale)) < 0.015) break;
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, scale > 1 ? -40 : 40);
    await page.keyboard.up('Control');
    await page.waitForTimeout(60);
  }
  for (let i = 0; i < 12; i++) {
    const box = await union(nodes);
    const dx = target.x + target.w / 2 - (box.x + box.w / 2);
    const dy = target.y + target.h / 2 - (box.y + box.h / 2);
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
    await page.mouse.move(view.width / 2, view.height / 2);
    await page.mouse.wheel(-dx / 0.5, -dy / 0.5);
    await page.waitForTimeout(200);
  }
}
