// Run: node --test apps/agor-ui/scripts/test-transcript-retention.mjs
// Production React + real lean ReactiveSessionHandle: old turns' tool payloads
// and reasoning must become collectable while the transcript stays mounted, not
// just leave the cache. Synthetic 256 KiB tool results and 64 KiB reasoning per
// turn; not a production memory measurement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { livePayloads, withProductionFixture } from './production-retention-harness.mjs';

/** Turns whose tool result (`tools`) and reasoning (`thinking`) strings are live. */
async function liveTurns(page, cdp) {
  // Let deferred pin releases and the eviction commit settle first.
  await page.waitForTimeout(300);
  await cdp.send('HeapProfiler.collectGarbage');
  // No size floor: Blink externalizes strings it renders (an expanded result is
  // a chain row), leaving a small V8 node. Snapshot names hold the content.
  const labels = await livePayloads(cdp, /^TRANSCRIPT_((?:RETENTION|THINKING)_\d+)_[xy]{512}/, 0);
  const of = (kind) =>
    [...new Set(labels.filter((label) => label.startsWith(`${kind}_`)))]
      .map((label) => Number(label.slice(kind.length + 1)))
      .sort((a, b) => a - b);
  return { tools: of('RETENTION'), thinking: of('THINKING') };
}

/**
 * Wait until a turn's expanded reasoning shows its payload. Deliberately not a
 * regex locator: the engine's last regex match is a GC root of its world.
 */
const reasoningShown = (page, taskId, n) =>
  page.waitForFunction(
    ([id, marker]) =>
      !!document.querySelector(`[data-task-block="${id}"]`)?.textContent?.includes(marker),
    [taskId, `TRANSCRIPT_THINKING_${n}_`]
  );

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const both = (turns) => ({ tools: turns, thinking: turns });

test('lean transcript releases old turn payloads beyond the recent-turn budget', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    const first = await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
    const turn = page.locator(`[data-task-block="${first}"]`);
    // A reader opens the first turn's tool calls and reasoning; those pins
    // outlive the budget.
    const chain = turn.getByRole('button', { name: '1 tool call' });
    await chain.click();
    await turn.getByText('Read').first().waitFor();
    const reasoning = turn.getByRole('button', { name: /Extended Thinking/ });
    await reasoning.click();
    await reasoningShown(page, first, 0);
    for (let n = 1; n < 30; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 29').waitFor();
    assert.deepEqual(
      await liveTurns(page, cdp),
      both([0, ...range(20, 29)]),
      'ten recent turns plus the expanded turn keep payloads; older payloads are collected'
    );

    await chain.click(); // collapse tools: the reasoning pin still holds the turn
    assert.deepEqual(await liveTurns(page, cdp), both([0, ...range(20, 29)]));
    await reasoning.click(); // collapse reasoning: the last pin is released
    assert.deepEqual(await liveTurns(page, cdp), both(range(20, 29)), 'collapsed turn is released');
    assert.equal(await page.getByText('Answer 0').count(), 1, 'lean history stays visible');

    // Re-expanding an evicted turn reloads its detail from persisted history.
    await page.evaluate(() => window.transcriptRetentionFixture.delayDetailReads(500));
    await turn.getByRole('button', { name: '1 tool call' }).click();
    await turn.getByRole('button', { name: 'Loading tool activity…' }).waitFor();
    await turn.getByText('Read').first().waitFor();
    await turn.getByRole('button', { name: /Extended Thinking/ }).click();
    await reasoningShown(page, first, 0);
    assert.deepEqual(await liveTurns(page, cdp), both([0, ...range(21, 29)]));

    await page.evaluate(() => window.transcriptRetentionFixture.unmount());
    assert.deepEqual(
      await liveTurns(page, cdp),
      both([]),
      'closing the reader releases everything'
    );
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
    assert.deepEqual(await liveTurns(page, cdp), both(range(20, 29)));
  });
});
