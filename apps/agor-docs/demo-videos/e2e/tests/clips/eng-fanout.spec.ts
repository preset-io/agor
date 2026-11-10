// Clip: eng-fanout (support/clips.ts). The five tickets EngBot found go from
// Backlog into In Progress at once, one person per card (the edit draws a
// troupe cursor on each). Each drop fires the zone's prompt, so a Claude
// session starts on every branch; the agents are held (agent: 'hold'), so
// all five keep spinning.
//
// Agor doesn't stream a card's position while someone drags it (watchers
// see it jump on drop), so the five simultaneous drags are puppeted: each
// card glides along its path through board-object updates, which the
// filmed board renders live, and its on-screen grip point is logged as
// that person's pointer (timeline actor `troupe-<n>`). The drop then fires
// the zone trigger exactly as the UI does.

import { expect, type Locator } from '@playwright/test';
import { AgorApi } from '../../support/api.ts';
import { frameNodes } from '../../support/canvas.ts';
import { CAST } from '../../support/cast.ts';
import { slot } from '../../support/puppet.ts';
import { PICKS } from '../../support/seeds/eng-flow.ts';
import { clip } from '../../support/studio.ts';

const STEP_MS = 50;
const DRAG_MS = 1700;
const STAGGER_MS = 220;

clip('eng-fanout', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true, cursor: false });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  const api = await AgorApi.login(CAST.sam.email, CAST.sam.password);
  const board = studio.world.board('eng');
  await sam.open(board.path);
  for (const pick of PICKS) await expect(sam.card(pick.name)).toBeVisible({ timeout: 30_000 });
  const zone = (label: string): Locator =>
    p
      .locator('.react-flow__node-zone')
      .filter({ has: p.getByText(label, { exact: true }) })
      .first();
  // Most of the board: where the work comes from and where it's going.
  await frameNodes(p, [zone('Backlog'), zone('In Progress'), zone('Review'), zone('QA')]);

  const objects = await api.find<{ object_id: string; branch_id?: string }>('/board-objects', {
    board_id: board.id,
    $limit: 50,
  });
  const objectOf = (name: string) => {
    const id = studio.world.branch(name).id;
    const o = objects.find((x) => x.branch_id === id);
    if (!o) throw new Error(`no board object for ${name}`);
    return o.object_id;
  };

  await studio.action();
  await sam.hold(900);

  // Canvas coordinates: Backlog's cards sit at (30, 70 + 220n) in a zone at
  // x 0; In Progress is at x 600 and stacks at slot(n).
  const lanes = PICKS.map((pick, i) => {
    const from = { x: 30, y: 70 + i * 220 };
    const to = { x: 600 + slot(i).x, y: slot(i).y };
    return { pick, i, from, to, object: objectOf(pick.name), card: sam.card(pick.name) };
  });

  // Log each card's grip (its header, where a hand would hold it) as its
  // person's pointer, every frame or so, for the whole move.
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      await Promise.all(
        lanes.map(async (l) => {
          const box = await l.card.boundingBox().catch(() => null);
          if (!box) return;
          studio.timeline.log({
            type: 'pointer',
            actor: `troupe-${l.i}`,
            wall: Date.now(),
            x: Math.round((box.x + box.width * 0.42) * 10) / 10,
            y: Math.round((box.y + 16) * 10) / 10,
          });
        })
      );
      await new Promise((r) => setTimeout(r, 33));
    }
  })();
  await sam.hold(400);

  studio.mark('drag');
  await Promise.all(
    lanes.map(async (l) => {
      await new Promise((r) => setTimeout(r, l.i * STAGGER_MS));
      const box = await l.card.boundingBox();
      if (box) {
        studio.timeline.log({
          type: 'click',
          actor: `troupe-${l.i}`,
          wall: Date.now(),
          x: box.x + box.width * 0.42,
          y: box.y + 16,
        });
      }
      const steps = Math.round(DRAG_MS / STEP_MS);
      for (let k = 1; k <= steps; k++) {
        const u = k / steps;
        const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2; // ease in-out
        // A hand lifts the card a little on the way over (an arc up and left of straight).
        const lift = Math.sin(e * Math.PI) * 90;
        await api.patch(`/board-objects/${l.object}`, {
          position: {
            x: l.from.x + (l.to.x - l.from.x) * e,
            y: l.from.y + (l.to.y - l.from.y) * e - lift,
          },
          zone_id: null,
        });
        await new Promise((r) => setTimeout(r, STEP_MS));
      }
      // Drop: pinned in the zone, and its prompt fires as a UI drop does.
      await api.patch(`/board-objects/${l.object}`, {
        position: slot(l.i),
        zone_id: board.zones.progress ?? 'zone-progress',
      });
      studio.mark(`drop-${l.i}`);
      await api.post(`/branches/${studio.world.branch(l.pick.name).id}/fire-zone-trigger`, {
        zoneId: board.zones.progress ?? 'zone-progress',
      });
    })
  );
  await sam.hold(500);
  sampling = false;
  await sampler;

  // Every drop started a session: all five spinners.
  await expect(p.locator('[aria-label="Running"]')).toHaveCount(PICKS.length, { timeout: 60_000 });
  studio.mark('running');
  await sam.hold(3000);
});
