// Clip: raise-personality (support/clips.ts). Agents with personality and
// identity: the crew in the teammate picker, the starter personas, and a
// new teammate taking shape.

import { dropdownOptions, skim } from '../../support/raise.ts';
import { clip } from '../../support/studio.ts';

clip('raise-personality', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  await sam.open('/');
  await studio.action();
  await sam.hold(600);

  // The picker: a dozen teammates, each with a job.
  studio.mark('picker');
  await sam.click(p.getByLabel('Teammate to ask').first());
  await sam.hold(400);
  await skim(sam, dropdownOptions(sam), 8);
  await p.mouse.wheel(0, 240);
  await sam.hold(300);
  await skim(sam, dropdownOptions(sam), 13, 180);
  await sam.press('Escape');
  await sam.hold(500);

  // The starter personas.
  await sam.open('/settings/teammates');
  await sam.hold(400);
  studio.mark('gallery');
  await sam.click(p.getByRole('button', { name: 'Create AI teammate' }).first());
  await sam.hold(800);
  const cards = p.locator('fieldset[aria-label="Teammate template"] [role="button"]');
  await skim(sam, cards, 9, 320);
  await sam.click(p.getByLabel('Filter templates by category').getByText('Grow'));
  await sam.hold(700);
  await sam.click(p.getByLabel('Filter templates by category').getByText('All'));
  await sam.hold(400);

  // A new teammate: a name, a persona, a job.
  studio.mark('configure');
  await sam.type(p.getByPlaceholder('e.g. PR Reviewer, Command Center'), 'DealBot');
  await sam.click(p.getByLabel('Deal Desk Analyst').first());
  await sam.hold(400);
  await sam.type(
    p.getByPlaceholder(/^e\.g\. Reviews PRs/),
    'Prices every deal and checks discounts against our policy.'
  );
  await sam.hold(400);
  await sam.glideTo(p.getByRole('button', { name: 'Create AI teammate' }).last());
  studio.mark('create');
  await sam.hold(1200);
});
