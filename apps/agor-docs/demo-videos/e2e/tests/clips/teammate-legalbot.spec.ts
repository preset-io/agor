// Clip: teammate-legalbot (support/clips.ts). Sam asks a real AI teammate a
// question in its session; the answer is a real agent turn (recorded with
// --live, replayed after).
//
//   npm run clip -- teammate-legalbot --live   # capture a new answer
//   npm run clip -- teammate-legalbot          # re-shoot from the recorded answer

import path from 'node:path';
import { FIXTURES_DIR } from '../../support/harness.ts';
import { askTeammate } from '../../support/scenes.ts';
import { clip } from '../../support/studio.ts';

clip('teammate-legalbot', async ({ studio }) => {
  await askTeammate(studio, {
    session: 'ask-legalbot',
    question: 'Please review the limitations of liability in this contract',
    attach: path.join(FIXTURES_DIR, 'docs', 'halvard-msa.pdf'),
  });
});
