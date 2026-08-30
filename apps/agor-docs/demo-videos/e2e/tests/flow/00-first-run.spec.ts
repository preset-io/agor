// Lesson 00 — First run: the onboarding wizard.
//
// A brand-new Agor workspace greets its first user with a short wizard.
// This lesson tours it: what the goal cards mean, what each step offers,
// and that everything here is skippable — the rest of the syllabus does
// each setup step deliberately, one lesson at a time. Ends on the Home
// dashboard with the "Get started with Agor" checklist, which is the
// syllabus's table of contents.

import { expect, test } from '@playwright/test';
import { beat, glideAndClick, openLesson, settle, spotlight } from '../../support/pacing.ts';

test('lesson 00: first run — tour and complete the onboarding wizard', async ({ page }) => {
  await openLesson(page, '/', '00-first-run');

  // The wizard greets the fresh workspace's first user.
  const wizardHeading = page.locator('text=what do you want to get done');
  await expect(wizardHeading).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // Step 1 — goals. Point out a couple of the intent cards, then pick one.
  await spotlight(page, page.locator('text=Get a personal teammate').first());
  await spotlight(page, page.locator('text=Build me an app').first());
  await glideAndClick(page, page.locator('text=Dig into anything').first());
  await beat(page);
  await glideAndClick(page, page.locator('button:has-text("Continue")').first());
  await settle(page);

  // Later steps (AI provider, teammate) each get their own lesson —
  // "Skip for now" through them to show that's always allowed.
  for (let i = 0; i < 6; i++) {
    const skip = page.locator('text=Skip for now').first();
    if (!(await skip.isVisible().catch(() => false))) break;
    await beat(page);
    await glideAndClick(page, skip);
    await settle(page);
  }

  // The wizard's last step confirms the workspace is ready ("You're ready
  // to build.") and offers the board it created. Take it — the lesson ends
  // where every later lesson begins: on a live board canvas.
  const openBoard = page.locator('button:has-text("Open my board")').first();
  await expect(openBoard).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await glideAndClick(page, openBoard);

  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await expect(wizardHeading).toBeHidden();
  await settle(page);
});
