// Clip: teammate-engbot (support/clips.ts). Sam asks a real AI teammate a
// question in its session; the answer is a real agent turn (recorded with
// --live, replayed after).
//
//   npm run clip -- teammate-engbot --live   # capture a new answer
//   npm run clip -- teammate-engbot          # re-shoot from the recorded answer

import { askTeammate } from '../../support/scenes.ts';
import { clip } from '../../support/studio.ts';

clip('teammate-engbot', async ({ studio }) => {
  await askTeammate(studio, {
    session: 'ask-engbot',
    question: "What's the team working on right now?",
  });
});
