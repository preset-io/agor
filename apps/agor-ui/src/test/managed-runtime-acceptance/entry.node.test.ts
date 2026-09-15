// @vitest-environment node
import { type Browser, chromium } from 'playwright';
import { expect, it } from 'vitest';
import { serveManagedAcceptanceUI } from './serve-ui';

/** Smoke proof only. The paired Cloud/provider acceptance suite must supply the real runtime. */
it.skipIf(process.env.AGOR_MANAGED_BROWSER_ACCEPTANCE !== '1')(
  'never fabricates Connected when the paired authenticated runtime is absent',
  async () => {
    const ui = await serveManagedAcceptanceUI();
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(
        `${ui.origin}/mcp-oauth/complete#ticket=${'T'.repeat(43)}&transaction_id=fake`
      );
      await page
        .getByText('Acceptance fixture connection unavailable', { exact: true })
        .waitFor()
        .catch(() => {
          throw new Error(`Fixture did not mount: ${pageErrors.join('; ')}`);
        });
      expect(await page.evaluate(() => window.location.hash)).toBe('');
      expect(await page.getByText('Connected', { exact: true }).count()).toBe(0);
    } finally {
      await browser?.close();
      await ui.close();
    }
  },
  90000
);
