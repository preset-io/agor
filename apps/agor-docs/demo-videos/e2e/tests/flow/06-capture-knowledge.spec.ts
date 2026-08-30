// Lesson 06 — Capture knowledge.
//
// Agor's Knowledge base is a shared, versioned markdown space that agents
// and people both read and write — docs can be @-mentioned in prompts and
// linked to each other. This lesson opens Knowledge from the header, hits
// New Page (which drops straight into a split markdown editor with live
// preview), writes running notes for the donut-shop work — the first
// heading becomes the page title — and saves.

import { expect, test } from '@playwright/test';
import { beat, glideAndClick, openLesson, settle } from '../../support/pacing.ts';

const DOC_BODY = [
  '# Donut Shop Field Notes',
  '',
  'Running notes for the glaze-menu refresh.',
  '',
  '- The storefront and back office share one Express API',
  '- MotherDuck holds the catalog: doughs, frostings, toppings',
  '- Next: refresh the seasonal combos',
].join('\n');

test('lesson 06: capture knowledge', async ({ page }) => {
  await openLesson(page, '/');

  // Knowledge lives one click away in the header.
  await glideAndClick(page, page.locator('[aria-label="Knowledge Base"]').first());
  await expect(page.locator('button:has-text("New Page")').first()).toBeVisible({
    timeout: 30_000,
  });
  await beat(page);

  // New Page drops straight into the editor: markdown on the left, live
  // preview on the right, "Use first heading as title" already on.
  await glideAndClick(page, page.locator('button:has-text("New Page")').first());
  const editor = page.locator('textarea').first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await beat(page);

  await glideAndClick(page, editor);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(DOC_BODY, { delay: 18 });

  // The preview pane keeps up as you type — let it breathe on screen.
  await expect(page.locator('text=Running notes for the glaze-menu refresh').nth(1)).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);

  await glideAndClick(page, page.locator('button:has-text("Save")').first());

  // Saved: the page now carries the heading as its title.
  await expect(page.locator('text=Donut Shop Field Notes').first()).toBeVisible({
    timeout: 15_000,
  });
  await settle(page);
});
