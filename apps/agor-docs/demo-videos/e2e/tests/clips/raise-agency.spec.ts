// Clip: raise-agency (support/clips.ts). Agents with agency: EngBot's
// schedules, and a new hourly heartbeat (which reads its HEARTBEAT.md).

import { openTeammate } from '../../support/raise.ts';
import { clip } from '../../support/studio.ts';

clip('raise-agency', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true, cursor: false });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  await sam.open('/settings/teammates');
  await studio.action();
  await openTeammate(sam, 'EngBot', 'Schedules');

  studio.mark('schedules');
  await sam.hold(1000);
  await sam.click(p.getByRole('button', { name: /New$/ }).first());
  await sam.hold(700);
  studio.mark('new-schedule');
  await sam.type(p.getByPlaceholder('Hourly heartbeat'), 'Hourly heartbeat');
  await sam.type(
    p.getByPlaceholder(/^Review the current state of/),
    'Read HEARTBEAT.md and execute a heartbeat.'
  );
  const cron = p.getByPlaceholder('0 * * * *');
  await sam.click(cron);
  await p.keyboard.press('ControlOrMeta+a');
  await p.keyboard.type('0 * * * *', { delay: 60 });
  await sam.hold(900);
  await sam.click(p.getByRole('button', { name: 'Create' }).last());
  studio.mark('created');
  await sam.hold(1800);
});
