// Clip: eng-flow (support/clips.ts). The late-fee ticket's trip across the
// EngTeam board after the build starts: the Review zone's prompt, Claude and
// Codex passing the PR back and forth, QA, a four-harness deep review, and
// a person dragging it to Merged; then Compose asks for 50 more.
//
// Agents' moves are staged live over REST (support/puppet.ts): there are no
// Codex, Gemini or Copilot keys here, and a real loop takes too long to
// film. agent: 'hold' parks the one real send (the closing ask).
// Cursorless: the edit's troupe does the clicking, dragging and typing.

import { expect, type Locator } from '@playwright/test';
import { AgorApi } from '../../support/api.ts';
import { frameNodes } from '../../support/canvas.ts';
import { CAST } from '../../support/cast.ts';
import { Puppet } from '../../support/puppet.ts';
import { HERO, HERO_PR, PICKS } from '../../support/seeds/eng-flow.ts';
import { clip } from '../../support/studio.ts';

clip('eng-flow', async ({ studio }) => {
  const sam = await studio.actor('sam', { filmed: true, cursor: false });
  const p = sam.page;
  p.setDefaultTimeout(20_000);
  const api = await AgorApi.login(CAST.sam.email, CAST.sam.password);
  const puppet = new Puppet(api, studio.world, 'eng');
  // Zone nodes by their exact label (card text like "Review PR" mustn't match).
  const z = (label: string): Locator =>
    p
      .locator('.react-flow__node-zone')
      .filter({ has: p.getByText(label, { exact: true }) })
      .first();

  await sam.open(studio.world.board('eng').path);
  await expect(sam.card(HERO)).toBeVisible({ timeout: 30_000 });
  // Everyone's building (the daemon settles sessions when it boots).
  for (const pick of PICKS)
    await puppet.running(studio.world.session(`build-${pick.name}`).id, true);
  await frameNodes(p, [z('In Progress'), z('Review'), z('QA')]);
  await studio.action();
  await sam.hold(1200);

  // The Review zone's prompt: "Put work on autopilot with Zones".
  studio.mark('zone-settings');
  const review = z('Review');
  // Selecting a zone shows its toolbar: click its empty lower half, then the gear.
  const rbox = await review.boundingBox();
  if (!rbox) throw new Error('the Review zone is not visible');
  await sam.move(rbox.x + rbox.width * 0.5, rbox.y + rbox.height * 0.75, 900);
  await p.mouse.click(rbox.x + rbox.width * 0.5, rbox.y + rbox.height * 0.75);
  await sam.click(p.getByRole('button', { name: 'Zone settings' }).first());
  await expect(p.getByText('Prompt template')).toBeVisible();
  studio.mark('zone-prompt');
  await sam.hold(3500);
  await sam.press('Escape');
  await sam.hold(800);

  // The loop: Claude opens a PR, Codex sends it back, Claude fixes it,
  // Codex approves, and it moves on to QA.
  const build = studio.world.session(`build-${HERO}`).id;
  studio.mark('pr');
  await puppet.running(build, false);
  await puppet.pr(HERO, HERO_PR);
  await sam.hold(900);
  await puppet.place(HERO, 'review', 0);
  studio.mark('to-review');
  const codex1 = await puppet.session(HERO, {
    agent: 'codex',
    title: 'Review PR #339 against SAASY-431',
    running: true,
  });
  await sam.hold(2200);
  await puppet.running(codex1, false);
  await puppet.retitle(codex1, 'Changes requested: timezone edge, missing test');
  studio.mark('changes');
  await sam.hold(1500);
  await puppet.place(HERO, 'progress', 0);
  studio.mark('back');
  await puppet.running(build, true);
  await puppet.retitle(build, 'Address review: due date in the customer’s timezone');
  await sam.hold(2200);
  await puppet.running(build, false);
  studio.mark('fixed');
  await sam.hold(600);
  await puppet.place(HERO, 'review', 0);
  const codex2 = await puppet.session(HERO, {
    agent: 'codex',
    title: 'Re-review PR #339',
    running: true,
  });
  await sam.hold(1800);
  await puppet.running(codex2, false);
  await puppet.retitle(codex2, 'Approved: ready for QA');
  studio.mark('approved');
  await sam.hold(1200);
  await puppet.place(HERO, 'qa', 0);
  studio.mark('to-qa');

  // QA: the shared environment and a Playwright test plan.
  const qa = await puppet.session(HERO, {
    title: 'QA: environment up, writing the test plan',
    running: true,
  });
  await sam.hold(2400);
  await puppet.retitle(qa, 'QA: 6 of 6 Playwright checks passed');
  await puppet.running(qa, false);
  studio.mark('qa-passed');
  await sam.hold(1500);

  // Off to the people: reframe on QA, Ready to merge and Merged (the edit cuts here).
  await puppet.place(HERO, 'ready', 0);
  studio.mark('reframe');
  await frameNodes(p, [z('QA'), z('Ready to merge'), z('Merged')]);
  await sam.hold(800);
  studio.mark('ready');

  // Deep review: four harnesses in parallel, as sub-sessions.
  const deep = await puppet.session(HERO, {
    title: 'Deep review PR #339 with Claude, Codex, Gemini and Copilot',
    running: true,
  });
  studio.mark('deep');
  await sam.hold(700);
  const reviewers: string[] = [];
  for (const [agent, title] of [
    ['claude-code', 'Claude: correctness and tests'],
    ['codex', 'Codex: edge cases'],
    ['gemini', 'Gemini: security'],
    ['copilot', 'Copilot: style and docs'],
  ] as const) {
    reviewers.push(await puppet.session(HERO, { agent, title, running: true, parent: deep }));
    await sam.hold(350);
  }
  studio.mark('deep-running');
  await sam.hold(2600);
  for (const r of reviewers) {
    await puppet.running(r, false);
    await sam.hold(300);
  }
  await puppet.retitle(deep, 'Deep review: 4 of 4 approve, 1 nit fixed');
  await puppet.running(deep, false);
  studio.mark('deep-done');
  await sam.hold(1500);

  // A person merges it.
  studio.mark('merge');
  await sam.dragTo(sam.card(HERO), z('Merged'), { fx: 0.05, fy: 0.06 }, 1400);
  studio.mark('merged');
  await sam.hold(1800);

  // "Let's pick 50 more tickets to work on."
  await sam.click(p.getByRole('button', { name: /^Compose/ }).first());
  const input = p.getByPlaceholder(/^Ask your primary assistant/).first();
  await expect(input).toBeVisible();
  await sam.hold(500);
  const box = await input.boundingBox();
  if (!box) throw new Error('compose input is not visible');
  studio.mark('more');
  await sam.typeStills(input, 'Let’s pick 50 more tickets to work on.', {
    x: Math.max(0, box.x - 40),
    y: Math.max(0, box.y - 30),
    w: Math.min(760, box.width + 80),
    h: Math.min(220, box.height + 60),
  });
  await sam.hold(500);
  studio.mark('send');
  await sam.click(p.getByRole('button', { name: 'Send in background' }).first());
  await sam.hold(1500);
});
