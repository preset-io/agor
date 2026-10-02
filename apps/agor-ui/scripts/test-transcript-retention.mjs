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

/** A reader moving on: focus and selection leave the transcript. */
const disengage = (page) =>
  page.evaluate(() => {
    document.activeElement?.blur();
    document.getSelection()?.removeAllRanges();
  });

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
    await disengage(page); // the collapsed trigger keeps its turn while focused
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

test('a reopened file edit, keyboard focus or a selection keeps its turn while engaged', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    const first = await page.evaluate(() =>
      window.transcriptRetentionFixture.addTurn({ edit: true })
    );
    const turn = page.locator(`[data-task-block="${first}"]`);
    const editShown = () =>
      page.evaluate(
        (id) =>
          !!document
            .querySelector(`[data-task-block="${id}"]`)
            ?.textContent?.includes('TRANSCRIPT_EDIT_0'),
        first
      );
    // Show the turn's activity, then close the tool calls again: the edit, open
    // by default inside the answer, stays visible with no tool-chain pin.
    const chainZero = turn.getByRole('button', { name: '1 tool call' });
    await chainZero.click();
    await chainZero.click();
    // The reader collapses and reopens the default-open edit.
    const edit = turn.locator('button[aria-expanded]').filter({ hasText: 'Edit/edit-0.txt' });
    assert.equal(await edit.getAttribute('aria-expanded'), 'true');
    await edit.click();
    await edit.click();
    assert.equal(await edit.getAttribute('aria-expanded'), 'true');
    await disengage(page); // isolate the reader's pin from focus protection
    for (let n = 1; n < 30; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 29').waitFor();
    assert.equal(await editShown(), true, 'the reopened diff stays beyond the budget');
    assert.deepEqual(await liveTurns(page, cdp), both([0, ...range(20, 29)]));
    await edit.click(); // collapse the reopened edit: its pin is released
    await disengage(page);
    assert.deepEqual(await liveTurns(page, cdp), both(range(20, 29)));

    // Keyboard: expand and collapse turn 20's tool calls, keeping focus there.
    const twenty = await page.evaluate(() => window.transcriptRetentionFixture.taskId(20));
    const chain = page
      .locator(`[data-task-block="${twenty}"]`)
      .getByRole('button', { name: '1 tool call' });
    await chain.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    assert.equal(await chain.getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => {
      window.__focused = document.activeElement;
    });
    // A reader selects text in turn 21.
    const selected = await page.evaluate(
      (id) => {
        const root = document.querySelector(`[data-task-block="${id}"]`);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.data.includes('Answer 21')) node = walker.nextNode();
        const range = document.createRange();
        range.selectNodeContents(node);
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
        return document.getSelection().toString();
      },
      await page.evaluate(() => window.transcriptRetentionFixture.taskId(21))
    );
    assert.equal(selected, 'Answer 21');
    for (let n = 30; n < 40; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 39').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([20, 21, ...range(30, 39)]));
    assert.equal(
      await page.evaluate(
        () => document.activeElement === window.__focused && window.__focused.isConnected
      ),
      true,
      'the focused trigger survives aging out'
    );
    assert.equal(await page.evaluate(() => document.getSelection().toString()), 'Answer 21');

    await page.evaluate(() => {
      window.__focused = undefined;
      document.activeElement?.blur();
    });
    assert.deepEqual(await liveTurns(page, cdp), both([21, ...range(30, 39)]), 'focus left');
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    assert.deepEqual(await liveTurns(page, cdp), both(range(30, 39)), 'selection cleared');
    await page.evaluate(() => window.transcriptRetentionFixture.unmount());
    assert.deepEqual(await liveTurns(page, cdp), both([]));
  });
});

test('a selection keeps every turn it spans, including a container-wide range', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    const ids = [];
    for (let n = 0; n < 10; n++) {
      ids.push(
        await page.evaluate((edit) => window.transcriptRetentionFixture.addTurn({ edit }), n === 1)
      );
    }
    await page.getByText('Answer 9').waitFor();
    // Show turn 1's default-open edit beside its answer, then close its tool calls.
    const chain = page.locator(`[data-task-block="${ids[1]}"]`).getByRole('button', {
      name: '1 tool call',
    });
    await chain.click();
    await chain.click();
    await disengage(page);
    // Select from turn 0's answer through turn 2's: turn 1 is wholly inside.
    const selection = await page.evaluate(
      ([from, to]) => {
        const textOf = (id, text) => {
          const walker = document.createTreeWalker(
            document.querySelector(`[data-task-block="${id}"]`),
            NodeFilter.SHOW_TEXT
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.data.includes(text)) return node;
          }
        };
        const range = document.createRange();
        range.setStart(textOf(from, 'Answer 0'), 0);
        range.setEnd(textOf(to, 'Answer 2'), 'Answer 2'.length);
        // selectionchange is dispatched asynchronously; let the transcript see it.
        const seen = new Promise((resolve) =>
          document.addEventListener('selectionchange', resolve, { once: true })
        );
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
        return seen.then(() => document.getSelection().toString());
      },
      [ids[0], ids[2]]
    );
    assert.match(selection, /TRANSCRIPT_EDIT_1/);
    for (let n = 10; n < 20; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 19').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([0, 1, 2, ...range(10, 19)]));
    assert.match(
      await page.evaluate(() => document.getSelection().toString()),
      /TRANSCRIPT_EDIT_1/,
      'the middle turn keeps its diff inside the selection'
    );
    await disengage(page);
    assert.deepEqual(await liveTurns(page, cdp), both(range(10, 19)));

    // A range whose boundaries are the conversation container itself.
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(
        document.querySelector('[data-testid="conversation-scroll-container"]')
      );
      const seen = new Promise((resolve) =>
        document.addEventListener('selectionchange', resolve, { once: true })
      );
      document.getSelection().addRange(range);
      return seen;
    });
    for (let n = 20; n < 30; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 29').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both(range(10, 29)));
    await disengage(page);
    assert.deepEqual(await liveTurns(page, cdp), both(range(20, 29)), 'selection cleared');
    await page.evaluate(() => window.transcriptRetentionFixture.unmount());
    assert.deepEqual(await liveTurns(page, cdp), both([]));
  });
});

test('a portaled fullscreen viewer keeps its turn open and focused until closed', {
  timeout: 120_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    const first = await page.evaluate(() =>
      window.transcriptRetentionFixture.addTurn({ table: true })
    );
    const turn = page.locator(`[data-task-block="${first}"]`);
    await turn.getByText('TABLE_0').waitFor();
    await turn.locator('[data-streamdown="table-wrapper"]').hover();
    await turn.getByTitle(/fullscreen/i).click();
    const viewer = page.locator('[data-streamdown="table-fullscreen"]');
    await viewer.waitFor();
    // The viewer is portaled outside the transcript; a control in it takes focus.
    const outside = await page.evaluate(() => {
      const overlay = document.querySelector('[data-streamdown="table-fullscreen"]');
      overlay.querySelector('button').focus();
      window.__viewer = overlay;
      window.__focused = document.activeElement;
      return (
        overlay.contains(document.activeElement) &&
        !document.querySelector('[data-testid="conversation-scroll-container"]').contains(overlay)
      );
    });
    assert.equal(outside, true);
    for (let n = 1; n < 30; n++) {
      await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 29').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([0, ...range(20, 29)]));
    assert.equal(
      await page.evaluate(
        () =>
          window.__viewer.isConnected &&
          document.activeElement === window.__focused &&
          window.__focused.isConnected
      ),
      true,
      'the viewer stays open with its focused control'
    );
    await page.getByTitle('Exit fullscreen').click();
    await viewer.waitFor({ state: 'detached' });
    await page.evaluate(() => {
      window.__viewer = undefined;
      window.__focused = undefined;
    });
    await disengage(page);
    assert.deepEqual(await liveTurns(page, cdp), both(range(20, 29)), 'closing releases it');
    await page.evaluate(() => window.transcriptRetentionFixture.unmount());
    assert.deepEqual(await liveTurns(page, cdp), both([]));
  });
});

test('a byte budget releases very large turns before the turn count would', {
  timeout: 180_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    const MiB = 1024 * 1024;
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    // Eight 6 MiB reads: within the ten-turn count, but only five fit 32 MiB.
    const ids = [];
    for (let n = 0; n < 8; n++) {
      ids.push(
        await page.evaluate(
          (bytes) => window.transcriptRetentionFixture.addTurn({ bytes }),
          6 * MiB
        )
      );
      await page.waitForTimeout(20);
    }
    await page.getByText('Answer 7').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both(range(3, 7)), 'oldest large turns released');

    // A reader re-expands an evicted large turn: its pin holds it within budget.
    const zero = page.locator(`[data-task-block="${ids[0]}"]`);
    const chain = zero.getByRole('button', { name: '1 tool call' });
    await chain.click();
    await zero.getByText('Read').first().waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([0, ...range(4, 7)]));

    // One read larger than the whole budget is kept only while protected.
    await chain.click();
    await disengage(page);
    const huge = await page.evaluate(
      (bytes) => window.transcriptRetentionFixture.addTurn({ bytes }),
      36 * MiB
    );
    await page.getByText('Answer 8').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([8]), 'the latest turn is protected');
    await page.evaluate(() => window.transcriptRetentionFixture.addTurn());
    await page.getByText('Answer 9').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([9]), 'no longer latest: released');
    const hugeTurn = page.locator(`[data-task-block="${huge}"]`);
    const hugeChain = hugeTurn.getByRole('button', { name: '1 tool call' });
    await hugeChain.click();
    await hugeTurn.getByText('Read').first().waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([8, 9]), 'reloaded and kept while expanded');
    await hugeChain.click();
    await disengage(page);
    assert.deepEqual(await liveTurns(page, cdp), both([9]), 'collapsed: released again');

    await page.evaluate(() => window.transcriptRetentionFixture.unmount());
    assert.deepEqual(await liveTurns(page, cdp), both([]));
  });
});

test('reloaded inline detail stays open and live while protected turns exceed the budget', {
  timeout: 180_000,
}, async () => {
  await withProductionFixture('ConversationView/TranscriptRetention', async (page, cdp) => {
    await page.waitForFunction(() => !!window.transcriptRetentionFixture);
    await page.evaluate(() => window.transcriptRetentionFixture.mount());
    // Detail beside visible text, with no AgentChain: reasoning, then a Read.
    const reasoningId = await page.evaluate(() =>
      window.transcriptRetentionFixture.addTurn({ inline: 'reasoning' })
    );
    const readId = await page.evaluate(() =>
      window.transcriptRetentionFixture.addTurn({ inline: 'read' })
    );
    // The latest turn alone holds more than the budget, so nothing else fits.
    await page.evaluate(
      (bytes) => window.transcriptRetentionFixture.addTurn({ bytes }),
      36 * 1024 * 1024
    );
    await page.getByText('Answer 2').waitFor();
    assert.deepEqual(await liveTurns(page, cdp), both([2]));

    // Reloading opens the detail the reader asked for, which then holds the turn.
    const reasoningTurn = page.locator(`[data-task-block="${reasoningId}"]`);
    await reasoningTurn.getByRole('button', { name: '1 tool call' }).click();
    await reasoningShown(page, reasoningId, 0);
    const readTurn = page.locator(`[data-task-block="${readId}"]`);
    await readTurn.getByRole('button', { name: '1 tool call' }).click();
    await page.waitForFunction(
      (id) =>
        !!document
          .querySelector(`[data-task-block="${id}"]`)
          ?.textContent?.includes('TRANSCRIPT_RETENTION_1_'),
      readId
    );
    await disengage(page);
    assert.deepEqual(
      await liveTurns(page, cdp),
      { tools: [1, 2], thinking: [0, 2] },
      'both reloads stay while open'
    );

    // Collapsing releases them to the budget, which has no room.
    await reasoningTurn.getByRole('button', { name: /Extended Thinking/ }).click();
    await readTurn.locator('button[aria-expanded]').filter({ hasText: 'Read' }).click();
    await disengage(page);
    assert.deepEqual(await liveTurns(page, cdp), both([2]), 'collapsed: released');
    assert.equal(await page.getByText('Answer 0').count(), 1, 'lean history stays visible');
    assert.equal(await page.getByText('Answer 1').count(), 1);

    await page.evaluate(() => window.transcriptRetentionFixture.unmount());
    assert.deepEqual(await liveTurns(page, cdp), both([]));
  });
});
