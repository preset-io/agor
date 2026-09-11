// Lesson 08 — Make the change.
//
// Lesson 04's session ended on a genuine offer: the agent proposed fixing
// donut-shop's ZIP-code delivery-fee bug and asked "Want me to implement
// this one?". This lesson picks that conversation back up from the branch
// card — sessions are durable, not throwaway chats — says yes, watches the
// agent edit for real, and reviews the diffs inline in the transcript.
//
// live: one real (metered) implementation turn, recorded to the cassette.
// replay: the recorded turn plays back — no network, no cost.

import { expect, test } from '@playwright/test';
import { BOARD_PATH, resolveAgentMode } from '../../support/harness.ts';
import {
  beat,
  glideAndClick,
  glideTo,
  openLesson,
  reassertCursor,
  settle,
  spotlight,
  typeInto,
} from '../../support/pacing.ts';

const agentMode = resolveAgentMode();
const BRANCH_NAME = 'glaze-menu-refresh';
const PROMPT =
  'Yes — implement it exactly as you proposed. Keep the diff tight and don’t touch anything unrelated.';

test.skip(!agentMode, 'set AGOR_E2E_AGENT_MODE=live|replay for the AI lessons');

test('lesson 08: make the change', async ({ page }) => {
  // One real implementation turn: the agent reads, edits, and verifies.
  test.setTimeout(1_500_000);
  await openLesson(page, BOARD_PATH, '08-make-the-change');
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // The lesson-04 conversation still lives on the branch card's session
  // list — click back into it.
  const card = page.locator(`.react-flow__node:has-text("${BRANCH_NAME}")`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });

  // Open the conversation from the left panel's Sessions tab — the
  // canvas cards can overlap each other (and intercept clicks), but the
  // panel list always works, and it's worth teaching anyway.
  const panel = page.locator('[data-panel-id="teammate-panel"]');
  await glideAndClick(page, panel.getByText('Sessions', { exact: true }).first());
  await beat(page);
  // The Sessions tab is a flat list titled by each session's first prompt.
  const sessionRow = panel.getByText(/Give me a quick tour/).first();
  await expect(sessionRow).toBeVisible({ timeout: 15_000 });
  await glideAndClick(page, sessionRow);

  const sessionPanel = page.locator('[data-panel-id="session-panel"]');
  await expect(sessionPanel).toBeVisible({ timeout: 15_000 });
  await settle(page);

  // Say yes to the standing offer.
  const composer = page
    .locator('textarea[placeholder*="Prompt here" i], textarea[placeholder*="typing" i]')
    .first();
  await typeInto(page, composer, PROMPT);
  await beat(page);
  await glideAndClick(page, page.locator('button:has-text("Send")').first());

  // Watch it work: RUNNING while the agent edits, IDLE when the diff lands.
  await expect(page.locator('text=RUNNING').first()).toBeVisible({ timeout: 30_000 });
  await reassertCursor(page);
  await expect(page.locator('text=IDLE').first()).toBeVisible({ timeout: 900_000 });
  await settle(page);

  // Review the work: every edit renders as an inline diff block in the
  // transcript (operation caption + file path + +/- stats).
  const diffBlock = page
    .locator('[data-conversation-block] strong', { hasText: /^(Update|Create)$/ })
    .last();
  await expect(diffBlock).toBeVisible({ timeout: 15_000 });
  await spotlight(page, diffBlock, 1600);
  await settle(page);

  // Close the panel and end on the card: the branch now carries real,
  // uncommitted work.
  await glideAndClick(page, page.locator('[aria-label="Close"], .anticon-close').first());
  await reassertCursor(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await glideTo(page, card);
  await settle(page);
});
