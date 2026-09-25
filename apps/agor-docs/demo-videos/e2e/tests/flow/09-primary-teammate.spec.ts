// Lesson 09 — A teammate for the board.
//
// The left panel has said "This board does not have a primary teammate
// yet." since lesson 00. A teammate is a long-lived agent with identity,
// memory, and goals, backed by the teammate framework repo. This lesson
// creates one through the Create dialog (its bootstrap session runs for
// real). Teammates preside over their OWN board — that's the product's
// model ("Each AI teammate gets a fresh board and becomes that board's
// primary teammate") — so the lesson ends there, with Sprinkles at the
// helm of Sprinkles's Board while its bootstrap continues in background.
// (Reassigning a teammate to another board hits a permission-override
// precondition — see ONBOARDING_FINDINGS.md.)
//
// live: the teammate's first-session bootstrap is a real (metered) run.
// replay: the recorded bootstrap plays back — no network, no cost.

import { expect, test } from '@playwright/test';
import { BOARD_PATH, resolveAgentMode } from '../../support/harness.ts';
import {
  beat,
  glideAndClick,
  openLesson,
  reassertCursor,
  settle,
  spotlight,
  typeInto,
} from '../../support/pacing.ts';

const agentMode = resolveAgentMode();
const TEAMMATE_NAME = 'Sprinkles';
const TEAMMATE_DESCRIPTION =
  'Keeps the donut-shop work moving: triages sessions, tracks branches, and remembers decisions.';

test.skip(!agentMode, 'set AGOR_E2E_AGENT_MODE=live|replay for the AI lessons');

test('lesson 09: a teammate for the board', async ({ page }) => {
  // The bootstrap session is a real multi-step agent run.
  test.setTimeout(1_800_000);
  await openLesson(page, BOARD_PATH, '09-primary-teammate');
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // The empty state we're here to fix.
  await spotlight(
    page,
    page.locator('text=This board does not have a primary teammate yet').first(),
    1400
  );

  // Create New... opens on the Teammate tab by default.
  await glideAndClick(
    page,
    page.locator('button.ant-btn-circle.ant-btn-lg:has(.anticon-plus)').first()
  );
  await beat(page);
  const dialog = page.locator('.ant-modal').last();
  await expect(dialog.locator('text=Each AI teammate gets a fresh board').first()).toBeVisible({
    timeout: 15_000,
  });

  // Name it, describe it, give it an agent.
  await typeInto(
    page,
    dialog.locator('input[placeholder*="PR Reviewer" i]').first(),
    TEAMMATE_NAME
  );
  await typeInto(
    page,
    dialog
      .locator('textarea[placeholder*="Reviews PRs" i], input[placeholder*="Reviews PRs" i]')
      .first(),
    TEAMMATE_DESCRIPTION
  );
  // The Agentic Tool select already defaults to Claude Code — leave it.
  // (No hover flourish here: the Select's readonly input overlays its
  // label and intercepts pointer events — a hover would spin forever.)
  await beat(page);

  // Worth knowing: teammates are backed by a framework repository
  // (preset-io/agor-teammate) — peek under Advanced Teammate Settings.
  await glideAndClick(page, dialog.locator('text=Advanced Teammate Settings').first());
  await spotlight(page, dialog.locator('text=Framework Repository').first(), 1200);

  await glideAndClick(page, dialog.locator('button:has-text("Create AI teammate")').first());

  // The teammate gets its own branch and its first session starts
  // automatically — the bootstrap prompt teaches it who it is. Watch it
  // get to work, but DON'T wait out the full bootstrap on camera (it's a
  // long, thorough run): the teammate onboards itself in the background
  // while you keep working — that's the story.
  await expect(page.locator(`text=${TEAMMATE_NAME} — first session`).first()).toBeVisible({
    timeout: 120_000,
  });
  await reassertCursor(page);
  await expect(page.locator('text=RUNNING').first()).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await settle(page);

  // The app landed us on the teammate's own board — where it presides.
  // The left panel already shows Sprinkles as this board's primary
  // teammate: identity, description, and its running first session.
  await reassertCursor(page);
  const teammatePanel = page.locator('[data-panel-id="teammate-panel"]');
  await expect(teammatePanel.getByText('Primary teammate', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(teammatePanel.locator(`text=${TEAMMATE_NAME}`).first()).toBeVisible();
  await spotlight(page, teammatePanel.getByText('Primary teammate', { exact: true }), 1400);
  await settle(page);
  await settle(page);
});
