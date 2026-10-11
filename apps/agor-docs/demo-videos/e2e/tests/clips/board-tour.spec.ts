// Clip: board-tour (support/clips.ts). Starts from the flow's
// pre-07-parallel-worktrees checkpoint: a board with the donut-shop repo,
// branches, and the zones lesson 05 drew. No agent turns.
//
//   npm run clip -- board-tour

import { expect, test } from '@playwright/test';
import { BOARD_PATH } from '../../support/harness.ts';
import { beat, glideTo, openLesson, settle, spotlight } from '../../support/pacing.ts';

test('clip: board-tour', async ({ page }) => {
  await openLesson(page, BOARD_PATH, 'board-tour');
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // Visit each card on the board in turn (zones and branch cards are both
  // React Flow nodes), lingering on each.
  const nodes = page.locator('.react-flow__node');
  const count = Math.min(await nodes.count(), 6);
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await spotlight(page, nodes.nth(i));
  }

  // Finish on a branch card, then let the whole board breathe.
  const card = page
    .locator('.react-flow__node')
    .filter({ hasText: /glaze|donut|menu/i })
    .first();
  if ((await card.count()) > 0) await glideTo(page, card);
  await settle(page);
});
