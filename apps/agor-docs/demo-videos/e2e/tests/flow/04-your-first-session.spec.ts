// Lesson 04 — Your first session.
//
// A session is a real agent conversation living on a branch. This lesson
// starts one from the branch card made in lesson 03: tour the coding-agent
// picker, give the session an initial prompt asking for a tour of the
// donut-shop codebase, and watch a genuine Claude Code reply stream into
// the transcript — the agent actually reads the repo to answer.
//
// live: one real (metered) Claude turn, recorded to the flow cassette.
// replay: the recorded turn plays back — no network, no cost.

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
const BRANCH_NAME = 'glaze-menu-refresh';
const PROMPT =
  'Give me a quick tour of this repo: what is the project, and how is the code organized? Keep it under 150 words.';
const FOLLOW_UP =
  "What's one small improvement you'd tackle first? Look at the code and propose it concretely — don't make any changes yet.";

test.skip(!agentMode, 'set AGOR_E2E_AGENT_MODE=live|replay for the AI lessons');

test('lesson 04: your first session', async ({ page }) => {
  // Two real model turns, each of which may read the repo at length.
  test.setTimeout(420_000);
  await openLesson(page, BOARD_PATH, '04-your-first-session');
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // Start a session straight from the branch card. The session panel opens
  // with a quickstart: "Choose which AI tool this session should use."
  const card = page.locator(`.react-flow__node:has-text("${BRANCH_NAME}")`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await glideAndClick(page, card.locator('text=/New Session|Create Session/').first());
  await beat(page);

  const picker = page.locator('text=Choose which AI tool').first();
  await expect(picker).toBeVisible({ timeout: 15_000 });

  // Agor speaks Claude Code, Codex, Gemini, OpenCode, and more. Point a
  // couple out, pick Claude Code.
  await spotlight(page, page.locator('text=OpenAI Codex coding agent').first(), 900);
  await spotlight(page, page.locator('text=Google Gemini coding agent').first(), 900);
  await glideAndClick(page, page.locator('text=Anthropic Claude coding agent').first());
  await beat(page);

  // Prompt the session — the agent reads the repo for real to answer.
  const composer = page
    .locator('textarea[placeholder*="Prompt here" i], textarea[placeholder*="typing" i]')
    .first();
  await typeInto(page, composer, PROMPT);
  await beat(page);
  await glideAndClick(page, page.locator('button:has-text("Send")').first());

  await reassertCursor(page);
  await expect(page.locator('text=MotherDuck').first()).toBeVisible({ timeout: 150_000 });
  await settle(page);

  // Sessions are conversations — follow up. Let the first turn fully wrap
  // (status back to IDLE), then ask the agent what it would improve; it goes
  // back into the code to answer.
  await expect(page.locator('text=IDLE').first()).toBeVisible({ timeout: 60_000 });
  await beat(page);
  await typeInto(page, composer, FOLLOW_UP);
  await beat(page);
  await glideAndClick(page, page.locator('button:has-text("Send")').first());

  // Watch it work: status flips to RUNNING while the agent reads code, then
  // returns to IDLE when the proposal lands.
  await expect(page.locator('text=RUNNING').first()).toBeVisible({ timeout: 30_000 });
  await reassertCursor(page);
  await expect(page.locator('text=IDLE').first()).toBeVisible({ timeout: 240_000 });
  await settle(page);
  await settle(page);
});
