// Clip: raise-integrity (support/clips.ts). Agents with integrity: a
// teammate grounded in the company's knowledge, then the Handbook's graph.

import { dropdownOptions, openTeammate, pickOption, skim } from '../../support/raise.ts';
import { clip } from '../../support/studio.ts';

clip('raise-integrity', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true, cursor: false });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  await sam.open('/settings/teammates');
  await studio.action();
  await openTeammate(sam, 'EngBot', 'Teammate Knowledge');

  studio.mark('kb-select');
  await sam.click(p.getByLabel('Home Knowledge namespace').first());
  await sam.hold(400);
  await skim(sam, dropdownOptions(sam), 8);
  await pickOption(sam, 'SaaSy Co. Handbook', 'Handbook');
  await sam.hold(500);
  await sam.click(p.getByRole('button', { name: 'Save home' }).first());
  await sam.hold(900);

  // The Handbook: ~200 linked pages.
  await sam.open('/kb/saasy-handbook');
  await p.locator('.react-flow__node').first().waitFor();
  await sam.hold(2500); // the force layout settles
  studio.mark('graph');
  await sam.move(960, 540, 900);
  await sam.hold(4000);
});
