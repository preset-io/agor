// Lesson 07 — Parallel work on isolated worktrees.
//
// The point of branches-as-cards: every branch is its own git worktree, so
// several agents can work the same repo at once without stepping on each
// other. This lesson spins up a second branch (no lingering this time —
// lesson 03 covered the options), starts a planning session on it, and
// ends wide on a board with two live branch cards.

import { expect, test } from '@playwright/test';
import { resolveAgentMode } from '../../support/harness.ts';
import {
  beat,
  glideAndClick,
  glideTo,
  openLesson,
  reassertCursor,
  settle,
  typeInto,
} from '../../support/pacing.ts';

const agentMode = resolveAgentMode();
const FIRST_BRANCH = 'glaze-menu-refresh';
const SECOND_BRANCH = 'daily-special-banner';
const PROMPT =
  "Sketch a plan for a '🍩 Daily Special' banner on the storefront: which files would you touch, and why? Plan only — no changes.";

test.skip(!agentMode, 'set AGOR_E2E_AGENT_MODE=live|replay for the AI lessons');

test('lesson 07: parallel work on isolated worktrees', async ({ page }) => {
  test.setTimeout(420_000);
  await openLesson(page, '/');
  await glideAndClick(page, page.getByRole('button', { name: "Admin's board" }).first());
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // A second branch off the same repo — quick this time.
  await glideAndClick(
    page,
    page.locator('button.ant-btn-circle.ant-btn-lg:has(.anticon-plus)').first()
  );
  await beat(page);
  const dialog = page.locator('.ant-modal').last();
  await glideAndClick(page, dialog.getByRole('tab', { name: 'Branch', exact: false }).first());
  await beat(page);
  await glideAndClick(page, page.locator('#repoId'));
  await glideAndClick(
    page,
    page.locator('.ant-select-item-option:has-text("donut-shop")').first(),
    12
  );
  await typeInto(page, page.locator('input[placeholder="feat-auth"]').first(), SECOND_BRANCH);
  await glideAndClick(page, page.locator('button:has-text("Create Branch")').last());

  const card = page.locator(`.react-flow__node:has-text("${SECOND_BRANCH}")`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('text=/New Session|Create Session/').first()).toBeVisible({
    timeout: 60_000,
  });
  await beat(page);

  // Its own session, its own worktree — the first branch's work is untouched.
  await glideAndClick(page, card.locator('text=/New Session|Create Session/').first());
  await expect(page.locator('text=Choose which AI tool').first()).toBeVisible({ timeout: 15_000 });
  await glideAndClick(page, page.locator('text=Anthropic Claude coding agent').first());
  await beat(page);
  const composer = page
    .locator('textarea[placeholder*="Prompt here" i], textarea[placeholder*="typing" i]')
    .first();
  await typeInto(page, composer, PROMPT);
  await glideAndClick(page, page.locator('button:has-text("Send")').first());
  await expect(page.locator('text=RUNNING').first()).toBeVisible({ timeout: 30_000 });
  await reassertCursor(page);
  await expect(page.locator('text=IDLE').first()).toBeVisible({ timeout: 240_000 });
  await settle(page);

  // Close the panel and end wide: two branch cards, two conversations, one
  // repo — zero collisions.
  await glideAndClick(page, page.locator('[aria-label="Close"], .anticon-close').first());
  await reassertCursor(page);
  const firstCard = page.locator(`.react-flow__node:has-text("${FIRST_BRANCH}")`).first();
  await expect(firstCard).toBeVisible({ timeout: 15_000 });
  await expect(card).toBeVisible();
  await glideTo(page, firstCard);
  await glideTo(page, card);
  await settle(page);
});
