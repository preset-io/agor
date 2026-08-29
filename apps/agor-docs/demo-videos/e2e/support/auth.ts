// Real login against the real Agor auth flow — no storageState shortcut by
// default, since the scratch DB (and therefore the session) is rebuilt every
// run; logging in for real is itself part of what makes this an honest E2E
// test, and it's cheap (one real form fill).

import type { Page } from '@playwright/test';
import { installCursor, moveToElement } from './cursor.ts';
import type { DEMO_USERS } from './harness.ts';

export async function loginAs(
  page: Page,
  user: (typeof DEMO_USERS)[keyof typeof DEMO_USERS]
): Promise<void> {
  await page.goto('/');
  await installCursor(page);
  await page.waitForSelector('input[placeholder*="Email" i]', { timeout: 15_000 });

  const email = page.locator('input[placeholder*="Email" i]').first();
  await moveToElement(page, email);
  await email.click();
  await page.keyboard.type(user.email, { delay: 30 });

  const password = page.locator('input[placeholder*="Password" i]').first();
  await moveToElement(page, password);
  await password.click();
  await page.keyboard.type(user.password, { delay: 30 });

  const signIn = page.locator('button:has-text("Sign In")').first();
  await moveToElement(page, signIn);
  await signIn.click();

  // Land on the authenticated dashboard before handing control back.
  await page.waitForSelector('text=Team activity', { timeout: 15_000 });
  await installCursor(page); // re-assert after the post-login re-render
}
