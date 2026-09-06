// Demo pacing grammar for the syllabus recordings. Every lesson uses these
// instead of raw locator.click()/keyboard.type() so the videos read as a
// human demoing the product, not a test racing through it:
//
// - the cursor GLIDES to a target over real wall-clock time (explicitly
//   paced, eased steps — never `mouse.move({steps})`, which fires every
//   step back-to-back so a whole glide lands inside 3-4 captured frames
//   and plays back as a low-framerate jump);
// - anything off-screen is SMOOTH-SCROLLED into view first, so the camera
//   never teleports to a target;
// - typing is real per-character keystrokes at demo speed;
// - `spotlight` hovers something worth noticing and holds, without
//   clicking — how a lesson points out options it isn't going to change;
// - `beat`/`settle` are the narrative pauses between steps and after
//   payoffs, sized for a viewer following along.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { installCursor } from './cursor.ts';
import { SCRATCH_DIR, snapshotCheckpoint } from './harness.ts';

/** Where each page's cursor currently rests (Playwright doesn't expose it). */
const cursorPos = new WeakMap<Page, { x: number; y: number }>();

const STEP_MS = 16; // target sampling cadence; wall-clock drives position

/** A short narrative pause between steps. */
export function beat(page: Page): Promise<void> {
  return page.waitForTimeout(700);
}

/** A longer hold on a payoff (a card landing, a reply arriving). */
export function settle(page: Page): Promise<void> {
  return page.waitForTimeout(1800);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Move the mouse to (x, y) over `durationMs` of real time, eased, along a
 * slightly arced path. This is the only way the suite moves the mouse:
 * each step gets its own frame's worth of wall-clock, so the recorded
 * glide is as smooth as the capture.
 *
 * The arc is a quadratic Bézier whose control point sits a little off the
 * straight line — bowing the way a right-handed wrist pivot does (a
 * rightward move bows gently upward). Subtle (8% of the distance, capped)
 * and deterministic: enough to stop reading as robotic, never a sweep.
 */
export async function pacedMove(page: Page, x: number, y: number, durationMs = 650): Promise<void> {
  const from = cursorPos.get(page) ?? { x: 960, y: 540 };
  const dx = x - from.x;
  const dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  const bow = Math.min(60, dist * 0.08);
  const perp = dist > 1 ? { x: dy / dist, y: -dx / dist } : { x: 0, y: 0 };
  const ctrl = {
    x: from.x + dx / 2 + perp.x * bow,
    y: from.y + dy / 2 + perp.y * bow,
  };
  // Sample the eased curve by WALL-CLOCK time, not by step count: a
  // fixed-delay step loop assumes each waitForTimeout takes exactly its
  // delay, but protocol jitter bunches steps up and the recorded cursor
  // leaps-then-crawls (measured 15px/2px/14px alternation per frame).
  // Position computed from elapsed time is always where a real hand would
  // be, so every captured frame samples a smooth trajectory.
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / durationMs);
    const e = easeInOut(t);
    const u = 1 - e;
    await page.mouse.move(
      u * u * from.x + 2 * u * e * ctrl.x + e * e * x,
      u * u * from.y + 2 * u * e * ctrl.y + e * e * y
    );
    if (t >= 1) break;
    await page.waitForTimeout(STEP_MS);
  }
  cursorPos.set(page, { x, y });
}

/** Smooth-scroll a target into the comfortable middle of the viewport. */
async function ensureInView(page: Page, target: Locator): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  const box = await target.boundingBox();
  if (box && box.y >= 90 && box.y + box.height <= viewport.height - 60) return;
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await page.waitForTimeout(800); // let the smooth scroll play out on camera
}

/** Glide the cursor to a locator's center and settle over it briefly. */
export async function glideTo(page: Page, target: Locator, durationMs = 650): Promise<void> {
  await ensureInView(page, target);
  const box = await target.boundingBox();
  if (!box) throw new Error('glideTo: target has no bounding box (not visible?)');
  await pacedMove(page, box.x + box.width / 2, box.y + box.height / 2, durationMs);
  await page.waitForTimeout(350);
}

/** Glide to a target and click it — the standard demo interaction. */
export async function glideAndClick(page: Page, target: Locator, durationMs = 650): Promise<void> {
  await glideTo(page, target, durationMs);
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
  // Bounded hover: an overlaying element (e.g. a Select's readonly input)
  // intercepts pointer events and would otherwise retry until the TEST
  // timeout. The glide already parked the visible cursor on the target,
  // so a failed hover costs nothing on camera.
  await target.hover({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(dwellMs);
}

/** Click into a field and type at a human demo cadence. */
export async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await glideAndClick(page, field);
  await page.keyboard.type(text, { delay: 45 });
  await page.waitForTimeout(300);
}

/** Per-lesson trim marks: how many seconds of app-loading to cut in the reel. */
const TRIM_MARKS_FILE = path.join(SCRATCH_DIR, 'trim-marks.jsonl');

/**
 * Open a lesson: navigate, wait out the app's loading screens, install the
 * cursor overlay, and record how long the load took so the reel stitcher
 * can trim it — recordings start rolling at context creation, but the reel
 * starts each lesson where the real UI (and the lesson's story) begins.
 */
export async function openLesson(page: Page, urlPath = '/', lessonId?: string): Promise<void> {
  // Checkpoint the quiescent pre-lesson workspace (previous lesson settled,
  // this one not started) so this lesson can later be re-run solo:
  //   AGOR_E2E_FROM_CHECKPOINT=pre-<lessonId> npx playwright test <spec>
  // Near-free via APFS clone; disable with AGOR_E2E_CHECKPOINTS=0.
  if (lessonId && process.env.AGOR_E2E_CHECKPOINTS !== '0') {
    snapshotCheckpoint(`pre-${lessonId}`);
  }
  const t0 = Date.now();
  await page.goto(urlPath);
  // Outlast both boot screens ("Loading..." shell, then "Loading workspace
  // data..."). They are SEQUENTIAL elements: waiting for `.first()` to hide
  // resolves when the shell loader unmounts while the workspace loader is
  // still coming, under-measuring the trim mark. Poll until no /^Loading/
  // text has been on screen for three consecutive checks.
  const loading = page.locator('text=/^Loading/');
  const bootDeadline = Date.now() + 90_000;
  let quietChecks = 0;
  while (Date.now() < bootDeadline && quietChecks < 3) {
    quietChecks = (await loading.count().catch(() => 1)) === 0 ? quietChecks + 1 : 0;
    await page.waitForTimeout(400);
  }
  if (lessonId) {
    const elapsed = (Date.now() - t0) / 1000;
    mkdirSync(SCRATCH_DIR, { recursive: true });
    appendFileSync(TRIM_MARKS_FILE, `${JSON.stringify({ lessonId, trimSeconds: elapsed })}\n`);
  }
  await installCursor(page);
  cursorPos.set(page, { x: 960, y: 540 });
  await page.waitForTimeout(800);
}

/** Re-assert the cursor overlay after an in-app navigation re-render. */
export async function reassertCursor(page: Page): Promise<void> {
  await installCursor(page);
}
