// Clip: two-cursors (support/clips.ts). The team-board seed, filmed from
// Sam's screen while Ada (a second, real signed-in browser) works on the
// same board: her live cursor is on Sam's canvas, and the card she drags
// moves there in real time.
//
//   npm run clip -- two-cursors

import { expect } from '@playwright/test';
import { clip } from '../../support/studio.ts';

const CARD = 'loyalty-punch-card';

clip('two-cursors', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true });
  const ada = await studio.actor('ada');
  const board = studio.world.board('main');
  await Promise.all([sam.open(board.path), ada.open(board.path)]);
  await expect(sam.card(CARD)).toBeVisible({ timeout: 30_000 });

  // Ada is already at work when the clip starts: her cursor is on Sam's board.
  await ada.glideTo(ada.card(CARD), 900);
  await expect(sam.remoteCursor('ada')).toBeVisible({ timeout: 20_000 });
  await studio.action();
  await sam.hold(1500);

  // Frame the move before it happens: her card and where it's headed.
  await sam.camera.focus([sam.card(CARD), sam.node('In review')], { ms: 1200 });
  await ada.dragTo(ada.card(CARD), ada.node('In review'), { fx: 0.05, fy: 0.4 });
  await sam.hold(900);

  // On Sam's screen, the card has landed in review, Ada's cursor beside it.
  await expect(sam.card(CARD)).toBeVisible();
  await sam.camera.focus(sam.card(CARD), { ms: 1000 });
  await sam.settle();
  await sam.camera.wide({ ms: 1300 });
  await sam.settle();
});
