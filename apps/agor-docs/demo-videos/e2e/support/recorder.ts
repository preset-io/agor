// Frame recorder for filmed actors: Chromium's own screencast, saved as-is.
//
// Playwright's built-in recorder encodes VP8 in real time while the test
// runs. At 4K that encoder can't keep up: on a long take (an agent thinking
// for minutes) it falls further and further behind and the video takes
// longer to finish than the take itself. Instead, every frame Chromium
// paints arrives here as a JPEG with its exact wall-clock time and is
// written straight to disk; nothing is encoded until export, which can take
// as long as it likes (scripts/lib/render.ts). The timestamps also make sync
// exact, with no need for a sync flash.
//
// Chromium only sends a frame when the screen changes, so a still screen
// costs nothing. Capture size follows the page's device pixels (4K with the
// --force-device-scale-factor=2 launch flag, see playwright.config.ts).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';

export interface FrameIndexLine {
  /** Frame file, relative to the frames directory. */
  file: string;
  /** Wall-clock time the frame was painted (ms since epoch). */
  wall: number;
}

export class FrameRecorder {
  private cdp: CDPSession | null = null;
  private seq = 0;
  private pending = Promise.resolve();
  readonly indexFile: string;

  constructor(
    private readonly page: Page,
    readonly dir: string,
    private readonly size: { width: number; height: number }
  ) {
    mkdirSync(dir, { recursive: true });
    this.indexFile = path.join(dir, 'index.jsonl');
    writeFileSync(this.indexFile, '');
  }

  async start(): Promise<void> {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (frame) => {
      const file = `${String(this.seq++).padStart(6, '0')}.jpg`;
      const wall = Math.round((frame.metadata.timestamp ?? Date.now() / 1000) * 1000);
      // Ack first so Chromium keeps painting; writes are queued in order.
      void this.cdp
        ?.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
        .catch(() => {});
      this.pending = this.pending.then(() => {
        writeFileSync(path.join(this.dir, file), Buffer.from(frame.data, 'base64'));
        appendFileSync(
          this.indexFile,
          `${JSON.stringify({ file, wall } satisfies FrameIndexLine)}\n`
        );
      });
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    });
  }

  /** Stop capturing and flush every frame to disk. */
  async stop(): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await this.cdp.detach().catch(() => {});
    this.cdp = null;
    await this.pending;
  }
}
