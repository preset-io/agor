// Clip: raise-agency (support/clips.ts). Agents with agency: EngBot's
// HEARTBEAT.md (what it does unasked), its schedules, and a new hourly
// heartbeat.

import { openTeammate } from '../../support/raise.ts';
import { clip } from '../../support/studio.ts';

clip('raise-agency', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  await sam.open('/settings/teammates');
  await studio.action();
  await openTeammate(sam, 'EngBot', 'Files');

  studio.mark('heartbeat');
  await sam.click(p.getByText('HEARTBEAT.md').first());
  await sam.hold(2600);
  await p.mouse.wheel(0, 300);
  await sam.hold(1200);
  // The preview's own Close (the teammate modal has one too).
  await sam.click(
    p.locator('.ant-modal:has-text("Copy Content")').getByRole('button', { name: 'Close' }).first()
  );
  await sam.hold(500);

  studio.mark('schedules');
  await sam.click(p.getByRole('tab', { name: 'Schedules' }).first());
  await sam.hold(1600);
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
