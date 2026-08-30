// Lesson 01 — Connect your project's repository.
//
// Every Agor workflow starts from a repo. This lesson opens the board's
// "Create New..." dialog, tours the Repository tab — you can clone straight
// from a GitHub URL, or register a clone you already have on disk — and
// registers the demo project (preset-io/donut-shop, materialized locally by
// the harness) from its local path.

import { expect, test } from '@playwright/test';
import { DEMO_REPO_PATH } from '../../support/harness.ts';
import {
  beat,
  glideAndClick,
  openLesson,
  settle,
  spotlight,
  typeInto,
} from '../../support/pacing.ts';

test('lesson 01: connect your repository', async ({ page }) => {
  await openLesson(page, '/', '01-connect-your-repository');

  // Home → open the board the wizard made for us.
  await glideAndClick(page, page.getByRole('button', { name: "Admin's board" }).first());
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  await beat(page);

  // The + button opens "Create New..." — branches, boards, teammates, repos.
  await glideAndClick(
    page,
    page.locator('button.ant-btn-circle.ant-btn-lg:has(.anticon-plus)').first()
  );
  await beat(page);
  const dialog = page.locator('.ant-modal').last();
  await glideAndClick(page, dialog.getByRole('tab', { name: 'Repository' }).first());
  await beat(page);

  // Two ways in: clone from a URL, or point Agor at an existing clone.
  await spotlight(page, page.locator('label:has-text("Remote (clone)")').first());
  await glideAndClick(page, page.locator('label:has-text("Local (existing)")').first());
  await beat(page);

  await typeInto(page, page.locator('input[placeholder="~/code/my-app"]').first(), DEMO_REPO_PATH);
  await beat(page);

  await glideAndClick(page, page.locator('button:has-text("Add Repository")').first());

  // The daemon inspects the clone and registers it.
  await expect(page.locator('text=Local repository added successfully').first()).toBeVisible({
    timeout: 30_000,
  });
  await settle(page);
});
