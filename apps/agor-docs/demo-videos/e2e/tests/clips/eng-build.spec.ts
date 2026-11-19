// Clip: eng-build (support/clips.ts). Sam switches to the empty EngTeam
// board and asks EngBot, through Compose, for a kanban board and then for
// five issues to work on; both are real turns (recorded with --live).
// Cursorless: the edit's troupe does the clicking and typing.
//
//   npm run clip -- eng-build --live   # record EngBot's turns
//   npm run clip -- eng-build --snappy # re-shoot from the recording

import { expect, type Page } from '@playwright/test';
import { AgorApi } from '../../support/api.ts';
import { CAST } from '../../support/cast.ts';
import { type Actor, clip, type Studio } from '../../support/studio.ts';

const compose = (p: Page) => p.getByRole('button', { name: /^Compose/ }).first();
const composeInput = (p: Page) => p.getByPlaceholder(/^Ask your primary assistant/).first();

/** Open Compose, type `text` as close-up stills, send it in the background. */
async function ask(studio: Studio, sam: Actor, text: string, mark: string): Promise<void> {
  const p = sam.page;
  await sam.click(compose(p));
  const input = composeInput(p);
  await expect(input).toBeVisible();
  await sam.hold(500);
  const box = await input.boundingBox();
  if (!box) throw new Error('compose input is not visible');
  studio.mark(mark);
  await sam.typeStills(input, text, {
    x: Math.max(0, box.x - 40),
    y: Math.max(0, box.y - 30),
    w: Math.min(760, box.width + 80),
    h: Math.min(220, box.height + 60),
  });
  await sam.hold(400);
  await sam.click(p.getByRole('button', { name: 'Send in background' }).first());
  studio.mark(`${mark}-sent`);
}

async function waitFor(sam: Actor, label: string, ok: () => Promise<boolean>, ms = 10 * 60_000) {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sam.page.waitForTimeout(500);
  }
}

clip('eng-build', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true, cursor: false });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  const api = await AgorApi.login(CAST.sam.email, CAST.sam.password);
  const eng = studio.world.board('eng');

  await sam.open(studio.world.board('saasy').path);
  await expect(sam.card('saasy-412-route-time-windows')).toBeVisible({ timeout: 30_000 });
  await studio.action();
  await sam.hold(800);

  // The board picker, then EngTeam.
  studio.mark('picker');
  await sam.click(p.locator('[data-current-board-name]').first());
  const popup = p.getByTestId('board-switcher-popup');
  await expect(popup).toBeVisible();
  await sam.hold(500);
  await sam.click(popup.getByText('EngTeam', { exact: true }).first());
  await p.waitForURL(`**${eng.path}**`);
  studio.mark('board');
  await sam.hold(1200);

  // "Build me a kanban board": EngBot lays out the workflow zones.
  await ask(studio, sam, 'Build me a kanban board for our workflow.', 'kanban');
  const zone = (label: string) => p.locator(`.react-flow__node:has-text("${label}")`).first();
  await waitFor(sam, 'the first zone', () => zone('Backlog').isVisible());
  studio.mark('zones-start');
  await waitFor(sam, 'all six zones', () => zone('Merged').isVisible());
  studio.mark('zones');
  await sam.hold(1500);

  // "Find 5 issues to work on": five ticket branches land in Backlog.
  await ask(studio, sam, 'Find 5 issues to work on.', 'issues');
  const count = async () =>
    (await api.find<{ board_id?: string }>('/branches', { board_id: eng.id, $limit: 50 })).length;
  // Agor drops new cards at a random height in a zone; stack each one in
  // the next slot the moment it appears, as a tidy team board would be.
  const placed: string[] = [];
  let tidying = true;
  const tidy = (async () => {
    while (tidying) {
      const objects = await api.find<{
        object_id: string;
        branch_id?: string;
        zone_id?: string;
      }>('/board-objects', { board_id: eng.id, $limit: 50 });
      for (const o of objects) {
        if (!o.branch_id || placed.includes(o.object_id)) continue;
        await api.patch(`/board-objects/${o.object_id}`, {
          position: { x: 30, y: 70 + placed.length * 220 },
          zone_id: 'zone-backlog',
        });
        placed.push(o.object_id);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  })();
  await waitFor(sam, 'the first ticket', async () => (await count()) >= 1);
  studio.mark('tickets-start');
  await waitFor(sam, 'five tickets', async () => (await count()) >= 5);
  // Done when every branch has its working directory and EngBot has replied.
  await waitFor(sam, 'five ready tickets', async () => {
    const rows = await api.find<{ filesystem_status?: string }>('/branches', {
      board_id: eng.id,
      $limit: 50,
    });
    return rows.length >= 5 && rows.every((b) => b.filesystem_status !== 'creating');
  });
  await waitFor(sam, "EngBot's reply", async () => {
    const [task] = await api.find<{ status: string }>('/tasks', {
      '$sort[created_at]': -1,
      $limit: 1,
    });
    return task?.status === 'completed';
  });
  tidying = false;
  await tidy;
  studio.mark('tickets');
  await sam.hold(2500);
});
