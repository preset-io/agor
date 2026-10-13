// Clip: eng-fanout (support/clips.ts). The five tickets EngBot found are
// dragged from Backlog into In Progress, one after another; each drop fires
// the zone's prompt and a Claude session starts on that ticket's branch.
// The agents are held (agent: 'hold'), so all five keep spinning.
// Cursorless: the edit's troupe does the dragging, a cursor per card.

import { expect } from '@playwright/test';
import { frameNodes } from '../../support/canvas.ts';
import { PICKS } from '../../support/seeds/eng-flow.ts';
import { clip } from '../../support/studio.ts';

clip('eng-fanout', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true, cursor: false });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  await sam.open(studio.world.board('eng').path);
  for (const pick of PICKS) await expect(sam.card(pick.name)).toBeVisible({ timeout: 30_000 });
  // Just Backlog and In Progress, big enough to read.
  const zoneNamed = (label: string) =>
    p
      .locator('.react-flow__node-zone')
      .filter({ has: p.getByText(label, { exact: true }) })
      .first();
  await frameNodes(p, [zoneNamed('Backlog'), zoneNamed('In Progress')]);
  await studio.action();
  await sam.hold(1000);

  const progress = p
    .locator('.react-flow__node-zone')
    .filter({ has: p.getByText('In Progress', { exact: true }) })
    .first();
  for (const [i, pick] of PICKS.entries()) {
    studio.mark(`drag-${i}`);
    await sam.dragTo(sam.card(pick.name), progress, { fx: 0.05, fy: 0.06 + i * 0.185 }, 1100);
    studio.mark(`drop-${i}`);
    await sam.hold(350);
  }
  // Every drop started a session: wait for all five spinners.
  await expect(p.locator('[aria-label="Running"]')).toHaveCount(PICKS.length, { timeout: 60_000 });
  studio.mark('running');
  await sam.hold(3000);
});
