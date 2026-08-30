// Lesson 05 — Organize your board.
//
// Boards are spatial: zones turn a free-form canvas into a workflow. This
// lesson draws two zones ("In Progress", "Review"), renames them inline,
// peeks at a zone's configuration — including the trigger template that can
// fire a prompt whenever a branch is dropped in — and then drags the
// donut-shop branch card into "In Progress".

import { expect, test } from '@playwright/test';
import {
  beat,
  glideAndClick,
  glideTo,
  openLesson,
  settle,
  spotlight,
} from '../../support/pacing.ts';

const BRANCH_NAME = 'glaze-menu-refresh';

/** Draw a rectangle on the canvas with the real mouse (zone tool active). */
async function drawRect(
  page: import('@playwright/test').Page,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): Promise<void> {
  await page.mouse.move(x1, y1, { steps: 20 });
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 30 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** Rename the most recent "New Zone" via its inline double-click editor. */
async function renameNewZone(page: import('@playwright/test').Page, name: string): Promise<void> {
  const label = page.locator('text=New Zone').last();
  await glideTo(page, label);
  await label.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(name, { delay: 45 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}

test('lesson 05: organize your board with zones', async ({ page }) => {
  await openLesson(page, '/');
  await glideAndClick(page, page.getByRole('button', { name: "Admin's board" }).first());
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // The zone tool lives in the canvas toolbar (the square icon). Draw the
  // first lane...
  const zoneTool = page.locator('.react-flow__controls button:has(.anticon-border)').first();
  await glideAndClick(page, zoneTool);
  // Draw in clear canvas space — a zone gesture must start on the pane, so
  // both rectangles stay well away from the branch card and each other.
  await drawRect(page, 560, 180, 880, 590);
  await renameNewZone(page, 'In Progress');
  await beat(page);

  // ...and a second one below it.
  await glideAndClick(page, zoneTool);
  await drawRect(page, 560, 650, 880, 1040);
  await renameNewZone(page, 'Review');
  await beat(page);

  // Zones are more than lanes: each can carry a trigger — a prompt template
  // that fires on an agent session whenever a branch is dropped in. Peek at
  // the configuration, then close without changing anything.
  const reviewZone = page.locator('.react-flow__node:has-text("Review")').first();
  await glideTo(page, reviewZone);
  await glideAndClick(page, reviewZone.locator('button[title="Configure zone"]').first());
  await spotlight(page, page.locator('label:has-text("Trigger Behavior")').first(), 1200);
  await spotlight(page, page.locator('label:has-text("Trigger Template")').first(), 1200);
  await glideAndClick(page, page.locator('.ant-modal button:has-text("Cancel")').first());
  await beat(page);

  // Drag the branch card into "In Progress" — the board is the workflow.
  const card = page.locator(`.react-flow__node:has-text("${BRANCH_NAME}")`).first();
  const cardBox = await card.boundingBox();
  const zone = page.locator('.react-flow__node:has-text("In Progress")').first();
  const zoneBox = await zone.boundingBox();
  if (!cardBox || !zoneBox) throw new Error('card or zone not on screen');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 10, { steps: 25 });
  await page.mouse.down();
  await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, {
    steps: 40,
  });
  await page.mouse.up();
  await settle(page);

  // Both zones exist; the card survived the move.
  await expect(page.locator('text=In Progress').first()).toBeVisible();
  await expect(page.locator('text=Review').first()).toBeVisible();
  await expect(card).toBeVisible();
  await settle(page);
});
