// Lesson 03 — Your first branch.
//
// Branches are the primary card on a board: an isolated git working
// directory with its own dev environment, where sessions do their work.
// This lesson opens the Create dialog's Branch tab, lingers on the options
// worth knowing about — source branch, worktree vs clone storage, the
// issue/PR link fields — creates a branch off donut-shop, and watches the
// card materialize on the canvas, error-free.

import { expect, test } from '@playwright/test';
import {
  beat,
  glideAndClick,
  glideTo,
  openLesson,
  settle,
  spotlight,
  typeInto,
} from '../../support/pacing.ts';

const BRANCH_NAME = 'glaze-menu-refresh';

test('lesson 03: your first branch', async ({ page }) => {
  await openLesson(page, '/');
  await glideAndClick(page, page.getByRole('button', { name: "Admin's board" }).first());
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  await glideAndClick(
    page,
    page.locator('button.ant-btn-circle.ant-btn-lg:has(.anticon-plus)').first()
  );
  await beat(page);
  // Scope to the dialog — the board's side panel has a "Branches" tab too.
  const dialog = page.locator('.ant-modal').last();
  await glideAndClick(page, dialog.getByRole('tab', { name: 'Branch', exact: false }).first());
  await beat(page);

  // Pick the repo we connected in lesson 01.
  await glideAndClick(page, page.locator('#repoId'));
  await glideAndClick(
    page,
    page.locator('.ant-select-item-option:has-text("donut-shop")').first(),
    12
  );
  await beat(page);

  // Worth knowing before we type a name: the source branch defaults to the
  // repo's default branch, storage can be a worktree (default) or a full
  // clone, and a branch can carry links to the issue/PR it exists for.
  await spotlight(page, page.locator('label:has-text("Source Branch")').first());
  await spotlight(page, page.locator('label:has-text("Worktree (default)")').first());
  await spotlight(page, page.locator('label:has-text("Clone")').first(), 900);
  await spotlight(page, page.locator('label:has-text("Issue URL")').first(), 900);

  await typeInto(page, page.locator('input[placeholder="feat-auth"]').first(), BRANCH_NAME);
  await beat(page);

  await glideAndClick(page, page.locator('button:has-text("Create Branch")').last());

  // The branch card lands on the canvas and the worktree materializes.
  const card = page.locator(`.react-flow__node:has-text("${BRANCH_NAME}")`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await glideTo(page, card);

  // Filesystem ready = the card offers to start a session; and no failure
  // state ever appears.
  await expect(card.locator('text=/New Session|Create Session/').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(card.locator('text=/failed|error/i')).toHaveCount(0);
  await settle(page);
});
