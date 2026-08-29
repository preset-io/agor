// Real-Agor E2E: create a branch from the dashboard's "+ New" menu, driving
// the actual production CreateDialog (BranchTab/BranchFormFields) against a
// real isolated daemon + DB — not the /demo/marketing-video fixture route.
// Doubles as a booth-loop video source via Playwright's built-in video
// recording (see playwright.config.ts `use.video`).

import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth';
import { installCursor, moveToElement } from '../support/cursor';
import { DEMO_USERS } from '../support/harness';

test('create a branch from the dashboard New menu', async ({ page }) => {
  await loginAs(page, DEMO_USERS.alice);

  // Dashboard "+ New" split button -> "New branch" menu item.
  const newButton = page.locator('button:has-text("New")').first();
  await moveToElement(page, newButton);
  await newButton.click();

  const newBranchItem = page.locator('text=New branch').first();
  await moveToElement(page, newBranchItem, 10);
  await newBranchItem.click();

  // Quick board-select dialog -> "Create branch" navigates to the board and
  // opens the full CreateDialog (Branch tab) there.
  const quickCreateButton = page.locator('button:has-text("Create branch")').first();
  await expect(quickCreateButton).toBeVisible();
  await moveToElement(page, quickCreateButton);
  await quickCreateButton.click();

  // The quick dialog's board choice doesn't carry into the full CreateDialog
  // — its own "Board" select (BranchFormFields, `requireBoard`) opens empty.
  const boardSelect = page.locator('#boardId');
  await expect(boardSelect).toBeVisible({ timeout: 10_000 });
  await moveToElement(page, boardSelect);
  await boardSelect.click({ force: true });
  const demoBoardOption = page.locator('.ant-select-item-option:has-text("Demo Board")').first();
  await moveToElement(page, demoBoardOption, 8);
  await demoBoardOption.click();

  // Full CreateDialog — BranchFormFields' name input is real-labeled "Branch
  // Name" with placeholder "feat-auth" (apps/agor-ui/src/components/BranchFormFields).
  const branchNameInput = page.locator('input[placeholder="feat-auth"]').first();
  await expect(branchNameInput).toBeVisible({ timeout: 10_000 });
  await moveToElement(page, branchNameInput);
  await branchNameInput.click();
  await branchNameInput.fill('');
  await page.keyboard.type('real-agor-e2e-demo', { delay: 40 });

  const submitButton = page.locator('button:has-text("Create Branch")').last();
  await moveToElement(page, submitButton);
  await page.waitForTimeout(400); // let the typed value settle on screen before submit
  await submitButton.click();

  // Real branch card lands on the real board.
  const branchCard = page.locator('text=real-agor-e2e-demo').first();
  await expect(branchCard).toBeVisible({ timeout: 15_000 });
  await installCursor(page); // re-assert after the board navigation/re-render
  await moveToElement(page, branchCard);
  await page.waitForTimeout(1000); // hold on the payoff for the recorded video
});
