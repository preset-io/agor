import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runStableCallbackFixture } from '../packages/core/src/tools/mcp/oauth-stable-callback.test-fixture';

// Use the UI workspace's declared browser dependency. No live provider or
// Cloud endpoint is contacted: the fixture hosts a disposable callback stub.
const require = createRequire(new URL('../apps/agor-ui/package.json', import.meta.url));
const { chromium } =
  require('playwright') as typeof import('../apps/agor-ui/node_modules/playwright');
const browser = await chromium.launch({ headless: true });
try {
  for (const confidential of [false, true]) {
    const page = await browser.newPage();
    await runStableCallbackFixture(confidential, async (url) => {
      await page.goto(url);
      assert.equal(await page.locator('p').textContent(), 'Callback received');
      return page.url();
    });
    await page.close();
    console.log(
      `Chromium ${confidential ? 'configured confidential' : 'DCR public'} OAuth: passed`
    );
  }
} finally {
  await browser.close();
}
