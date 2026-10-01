// Run: node --test apps/agor-ui/scripts/test-transcript-retention.mjs
// Production React + real lean ReactiveSessionHandle: old turns' tool payloads
// must become collectable while the transcript stays mounted, not just leave
// the cache. Synthetic 256 KiB payloads; not a production memory measurement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { livePayloads, withProductionFixture } from './production-retention-harness.mjs';

async function liveTurns(page, cdp) {
  // Let deferred pin releases and the alternate-retiring commit settle first.
  await page.waitForTimeout(300);
  await cdp.send('HeapProfiler.collectGarbage');
  // No size floor: Blink externalizes strings it renders (an expanded result is
  // a chain row), leaving a small V8 node. Snapshot names hold the content.
  const turns = await livePayloads(cdp, /^TRANSCRIPT_RETENTION_(\d+)_x{512}/, 0);
  return [...new Set(turns.map(Number))].sort((a, b) => a - b);
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('lean transcript releases old turn payloads beyond the recent-turn budget', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    const first = await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
    const turn = page.locator(`[data-task-block="${first}"]`);
    // A reader opens the first turn's tool calls; that pin outlives the budget.
    const chain = turn.getByRole('button', { name: '1 tool call' });
    await chain.click();
    await turn.getByText('Read').first().waitFor();
    for (let n = 1; n < 30; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 29').waitFor();
    assert.deepEqual(
      await liveTurns(page, cdp),
      [0, ...range(20, 29)],
      'ten recent turns plus the expanded turn keep payloads; older payloads are collected'
    );

    await chain.click(); // collapse: the pin is released
    assert.deepEqual(await liveTurns(page, cdp), range(20, 29), 'collapsed turn is released');
    assert.equal(await page.getByText('Answer 0').count(), 1, 'lean history stays visible');

    // Re-expanding an evicted turn reloads its detail from persisted history.
    await turn.getByRole('button', { name: '1 tool call' }).click();
    await turn.getByText('Read').first().waitFor();
    assert.deepEqual(await liveTurns(page, cdp), [0, ...range(21, 29)]);

    await page.evaluate(() => window.transcriptRetentionFixture.unmount());
    assert.deepEqual(await liveTurns(page, cdp), [], 'closing the reader releases everything');
  });
});

test('lean transcript releases turns that were already full when the reader opened', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.prehydrate());
    for (let n = 0; n < 3; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
    }
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    await page.getByText('Answer 2').waitFor();
    for (let n = 3; n < 30; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 29').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), range(20, 29));
  });
});
