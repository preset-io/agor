// Clip: teammate-opsbot (support/clips.ts). Sam asks a real AI teammate a
// question in its session; the answer is a real agent turn (recorded with
// --live, replayed after).
//
//   npm run clip -- teammate-opsbot --live   # capture a new answer
//   npm run clip -- teammate-opsbot          # re-shoot from the recorded answer

import { askTeammate } from '../../support/scenes.ts';
import { clip } from '../../support/studio.ts';

clip('teammate-opsbot', async ({ studio }) => {
  await askTeammate(studio, {
    session: 'ask-opsbot',
    question: 'How are my sales doing over the last 90 days?',
  });
});
