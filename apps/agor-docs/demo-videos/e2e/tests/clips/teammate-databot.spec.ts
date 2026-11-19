// Clip: teammate-databot (support/clips.ts). Sam asks a real AI teammate a
// question in its session; the answer is a real agent turn (recorded with
// --live, replayed after).
//
//   npm run clip -- teammate-databot --live   # capture a new answer
//   npm run clip -- teammate-databot          # re-shoot from the recorded answer

import { askTeammate } from '../../support/scenes.ts';
import { clip } from '../../support/studio.ts';

clip('teammate-databot', async ({ studio }) => {
  await askTeammate(studio, {
    session: 'ask-databot',
    question: 'How do we define MAU?',
  });
});
