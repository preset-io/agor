// Run: node --test apps/agor-ui/scripts/test-global-search-retention.mjs
// Requires repository Playwright Chromium. Builds real production React, serves
// real loopback HTTP, and tests collection (not merely absence from a store).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { livePayloads, withProductionFixture } from './production-retention-harness.mjs';

const payloadCount = async (cdp) => (await livePayloads(cdp, /^RETENTION_\d+_\d+_/)).length;

// The first callback is born with the payload-bearing map. An inline stable
// wrapper sharing the publication effect's scope would retain that callback,
// even after ref.current is replaced. Both payload and object collection count.
test('GlobalSearch releases obsolete payloads across two mounted cycles', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('GlobalSearch/GlobalSearch.retention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.searchRetentionFixture);
    for (let cycle = 1; cycle <= 2; cycle++) {
      await page.evaluate((n) => window.searchRetentionFixture.populate(n), cycle);
      await page.waitForTimeout(300);
      if (cycle === 2) {
        await page.keyboard.press('Control+k');
        await page.getByRole('combobox', { name: 'Global search' }).fill('search fixture');
        await page.waitForTimeout(300);
      }
      assert.equal(await page.evaluate(() => window.searchRetentionFixture.alive()), 32);
      assert.equal(await payloadCount(cdp), 32, 'positive control: all payload strings are live');
      await page.evaluate(() => window.searchRetentionFixture.archive());
      // React legitimately retains one previous render in the alternate fiber.
      // A second bounded commit retires it; the component stays mounted, with
      // the original shortcut listener and query/flush identities unchanged.
      await page.waitForTimeout(300);
      await page.evaluate(() => window.searchRetentionFixture.archive());
      await page.waitForTimeout(300);
      await cdp.send('HeapProfiler.collectGarbage');
      assert.equal(
        await payloadCount(cdp),
        0,
        `cycle ${cycle}: obsolete description payloads survived GC`
      );
      if (cycle === 2) await page.getByRole('button', { name: 'Close search' }).click();
      assert.equal(
        await page.evaluate(() => window.searchRetentionFixture.alive()),
        0,
        `cycle ${cycle}: obsolete session objects (and their descriptions) remain reachable`
      );
    }
    await page.evaluate(() => window.searchRetentionFixture.unmount());
  });
});

test('GlobalSearch Enter uses committed callbacks across a suspended transition', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('GlobalSearch/GlobalSearch.concurrent', async (page) => {
    await page.getByRole('button', { name: 'Open search' }).click();
    const input = page.getByRole('combobox', { name: 'Global search' });
    await input.fill('deploy');
    // Highlighting proves debounce committed; the same title also exists in recents.
    await page
      .getByRole('option', { name: /deploy A/ })
      .locator('mark')
      .waitFor();
    // Emulate a data update without an outside mousedown closing the popover.
    await page
      .getByRole('button', { name: 'Suspend replacement' })
      .evaluate((button) => button.click());
    await page.waitForFunction(() => window.searchConcurrentFixture.attempted());
    assert.equal(await page.getByTestId('committed-version').innerText(), '0');
    assert.equal(await page.getByTestId('fallback').count(), 0);
    assert.equal(await page.getByRole('option', { name: /deploy A/ }).count(), 1);
    assert.equal(await page.getByRole('option', { name: /deploy B/ }).count(), 0);
    await input.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="location"]')?.textContent !== '/'
    );
    assert.match(await page.getByTestId('location').innerText(), /^\/s\/11111111/);

    // Once B really commits, the same mounted search must use B, not stale A.
    await page.evaluate(() => window.searchConcurrentFixture.release());
    await page.waitForFunction(
      () => document.querySelector('[data-testid="committed-version"]')?.textContent === '1'
    );
    await page.getByRole('button', { name: 'Open search' }).click();
    await input.fill('deploy');
    await page
      .getByRole('option', { name: /deploy B/ })
      .locator('mark')
      .waitFor();
    await input.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="location"]')?.textContent?.startsWith('/s/22222222')
    );
    assert.match(await page.getByTestId('location').innerText(), /^\/s\/22222222/);
  });
});
