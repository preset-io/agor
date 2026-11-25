// Clip: board-tour (support/clips.ts). The team-board seed: Sam's view of
// the Donut Shop board, four zones with branches in flight. No agent turns.
//
//   npm run clip -- board-tour

import { expect } from '@playwright/test';
import { clip } from '../../support/studio.ts';

clip('board-tour', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true });
  await sam.open(studio.world.board('main').path);
  await expect(sam.card('glaze-menu-refresh')).toBeVisible({ timeout: 30_000 });
  await studio.action();
  await sam.hold(1500);

  // Push in on the branch being built.
  await sam.camera.focus(sam.card('glaze-menu-refresh'), { ms: 1200 });
  await sam.spotlight(sam.card('glaze-menu-refresh'));

  // Across to the branch waiting on review.
  await sam.camera.focus(sam.card('order-ahead-checkout'), { ms: 1100 });
  await sam.spotlight(sam.card('order-ahead-checkout'));

  // And back out to the whole board.
  await sam.camera.wide({ ms: 1300 });
  await sam.settle();
});
