// Reusable shots built on the studio. A scene is a sequence of beats several
// clips share; the clip spec decides the specifics.

import { expect } from '@playwright/test';
import { AgorApi } from './api.ts';
import { CAST } from './cast.ts';
import type { Studio } from './studio.ts';

export interface AskOptions {
  /** World name of the (empty) session to ask in; the seed creates it on the teammate's branch. */
  session: string;
  question: string;
  /** A file to attach with the paperclip before asking (absolute path). */
  attach?: string;
  /** How long to hold on the finished answer. */
  holdMs?: number;
}

/**
 * Sam opens a teammate's session, (optionally attaches a file,) types the
 * question, sends it, and the clip holds while the real answer streams in.
 * Marks: 'question', 'sent', 'answered'.
 */
export async function askTeammate(studio: Studio, options: AskOptions): Promise<void> {
  const sam = await studio.actor('sam', { filmed: true });
  const session = studio.world.session(options.session);
  // Full id: short ids are the first 8 hex chars of a time-based UUID, so
  // sessions a seed creates within the same minute share one (and the app
  // falls back to Home on an ambiguous link).
  await sam.open(`/s/${session.id}/`);
  const prompt = sam.page.getByPlaceholder(/^Prompt here/).first();
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await studio.action();
  await sam.hold(900);

  // Camera, act 1: a close-up (about 2x) on the lower half of the session
  // panel, where the question is typed. Masters get the moves; raw cuts
  // never do.
  const box = await prompt.boundingBox();
  const viewport = sam.page.viewportSize() ?? { width: 1920, height: 1080 };
  const left = box ? Math.max(0, box.x - 24) : viewport.width / 2;
  const panel = { x: left, y: 64, w: viewport.width - left, h: viewport.height - 64 };
  await sam.camera.focus(
    { x: left, y: viewport.height / 2, w: viewport.width - left, h: viewport.height / 2 },
    { zoom: 1.95, ms: 1600 }
  );

  studio.mark('question');
  if (options.attach) {
    const chooser = sam.page.waitForEvent('filechooser');
    await sam.click(sam.page.getByRole('button', { name: 'Attach files' }).first());
    await (await chooser).setFiles(options.attach);
    await sam.hold(900);
  }
  await sam.type(prompt, options.question);
  await sam.hold(500);
  studio.mark('sent');
  await sam.press('Enter');
  // Act 2: ease out to the whole session panel, so the question and the
  // answer (which starts near the top of a short conversation) stay in frame.
  await sam.camera.focus(panel, { zoom: 1.25, ms: 1400, wait: false });

  // Wait for the real turn to finish (live or replayed), over REST.
  const api = await AgorApi.login(CAST.sam.email, CAST.sam.password);
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const tasks = await api.find<{ status: string }>('/tasks', {
      session_id: session.id,
      '$sort[created_at]': -1,
      $limit: 1,
    });
    const status = tasks[0]?.status;
    if (status === 'completed') break;
    if (status === 'failed' || status === 'stopped' || status === 'timed_out') {
      throw new Error(`the agent turn ended ${status}`);
    }
    if (Date.now() > deadline) throw new Error('the agent turn did not finish in 15 minutes');
    await sam.hold(1000);
  }
  studio.mark('answered');
  await sam.hold(options.holdMs ?? 3000);
  // Pull back to show where the answer lives: the board and the teammate.
  await sam.camera.wide({ ms: 1600 });
  await sam.hold(2000);
}
