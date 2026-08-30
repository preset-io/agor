// Demo pacing grammar for the syllabus recordings. Every lesson uses these
// instead of raw locator.click()/keyboard.type() so the videos read as a
// human demoing the product, not a test racing through it:
//
// - the cursor GLIDES to a target (eased, many steps), settles briefly,
//   then clicks — never teleports;
// - typing is real per-character keystrokes at demo speed;
// - `spotlight` hovers something worth noticing and holds, without clicking —
//   how a lesson points out options it isn't going to change;
// - `beat`/`settle` are the narrative pauses between steps and after
//   payoffs, sized for a viewer following along, not for CI throughput.

import type { Locator, Page } from '@playwright/test';
import { installCursor } from './cursor.ts';

/** A short narrative pause between steps. */
export function beat(page: Page): Promise<void> {
  return page.waitForTimeout(700);
}

/** A longer hold on a payoff (a card landing, a reply arriving). */
export function settle(page: Page): Promise<void> {
  return page.waitForTimeout(1800);
}

/** Glide the cursor to a locator's center and settle over it briefly. */
export async function glideTo(page: Page, target: Locator, steps = 35): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('glideTo: target has no bounding box (not visible?)');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
  await page.waitForTimeout(350);
}

/** Glide to a target and click it — the standard demo interaction. */
export async function glideAndClick(page: Page, target: Locator, steps = 35): Promise<void> {
  await glideTo(page, target, steps);
  await target.click();
  await page.waitForTimeout(250);
}

/**
 * Point out something without changing it: glide onto it, dwell long enough
 * for a viewer to read it, and move on. The lesson's way of saying "note
 * these options exist".
 */
export async function spotlight(page: Page, target: Locator, dwellMs = 1400): Promise<void> {
  await glideTo(page, target);
  await target.hover();
  await page.waitForTimeout(dwellMs);
}

/** Click into a field and type at a human demo cadence. */
export async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await glideAndClick(page, field);
  await page.keyboard.type(text, { delay: 45 });
  await page.waitForTimeout(300);
}

/**
 * Open a lesson: navigate, install the cursor overlay, and let the page
 * finish painting before anything moves. Every lesson starts here so the
 * recording opens on a stable, signed-in UI (auth comes from the harness's
 * storageState — login is never part of a recording).
 */
export async function openLesson(page: Page, urlPath = '/'): Promise<void> {
  await page.goto(urlPath);
  await installCursor(page);
  await page.waitForTimeout(1500);
}

/** Re-assert the cursor overlay after an in-app navigation re-render. */
export async function reassertCursor(page: Page): Promise<void> {
  await installCursor(page);
}
