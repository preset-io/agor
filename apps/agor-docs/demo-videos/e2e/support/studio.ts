// The clip studio: what tests/clips/*.spec.ts are written against.
//
//   clip('two-cursors', async ({ studio }) => {
//     const sam = await studio.actor('sam', { filmed: true });
//     const ada = await studio.actor('ada');
//     const board = studio.world.board('main');
//     await Promise.all([sam.open(board.path), ada.open(board.path)]);
//     await studio.action();                       // the clip starts here
//     await sam.camera.focus(sam.card('glaze-menu-refresh'));
//     await ada.drag(ada.card('glaze-menu-refresh'), { dx: 260, dy: 180 });
//     await sam.camera.wide();
//   });
//
// - Every person is an Actor: their own signed-in browser, cursor, and
//   pacing. Filmed actors are recorded; the others are still really there
//   (Agor shows their live cursors and edits to everyone else).
// - The camera is virtual. focus()/wide() log where to frame; the export
//   step renders eased zooms and pans from the log (scripts/lib/render.ts).
//   Change a zoom by editing the take's timeline.jsonl and re-exporting.
// - studio.world is what the clip's seed built (seeds.ts): boards, branches,
//   sessions, by name, so specs never hardcode ids or slugs.
// - A clip that passes leaves a post-<id> checkpoint, so another clip can
//   start where this one ended (ClipMeta.start = { after: '<id>' }).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type Browser,
  type BrowserContext,
  test as base,
  type Locator,
  type Page,
} from '@playwright/test';
import { AgorApi } from './api.ts';
import { CAST, type CastKey } from './cast.ts';
import { clipById } from './clips.ts';
import { installCursor } from './cursor.ts';
import { BASE_URL, DEMO_TIMEZONE, snapshotCheckpoint } from './harness.ts';
import {
  beat,
  cursorPosition,
  glideAndClick,
  glideTo,
  observePacing,
  paced,
  pacedMove,
  pacedPath,
  setCursorPosition,
  settle,
  spotlight,
  typeInto,
} from './pacing.ts';
import { FrameRecorder } from './recorder.ts';
import { type Ease, type Rect, Timeline, takeDir } from './timeline.ts';
import { readWorld, type World } from './world.ts';

// Same switch as playwright.config.ts (which also sets the launch flag 4K needs).
const FOUR_K = process.env.AGOR_E2E_VIDEO === '4k';
const VIEWPORT = { width: 1920, height: 1080 };
const SCALE = FOUR_K ? 2 : 1;

/** Agor hides a remote cursor after ~5s without movement; nudge well before that. */
const PRESENCE_IDLE_MS = 3000;

export interface FocusOptions {
  /** Zoom factor; default fits the target with breathing room (capped by the source). */
  zoom?: number;
  /** Transition length. */
  ms?: number;
  ease?: Ease;
  /** Wait for the move to finish before the script continues (default true). */
  wait?: boolean;
}

export class Camera {
  constructor(
    private readonly actor: Actor,
    private readonly timeline: Timeline
  ) {}

  /** Frame one element, several (their union), or a viewport rectangle. */
  async focus(target: Locator | Locator[] | Rect, options: FocusOptions = {}): Promise<void> {
    const rect = await resolveRect(target);
    await this.move(rect, options);
  }

  /** Back to the full frame. */
  async wide(options: Omit<FocusOptions, 'zoom'> = {}): Promise<void> {
    await this.move(null, options);
  }

  private async move(rect: Rect | null, options: FocusOptions): Promise<void> {
    const ms = paced(options.ms ?? 1000);
    this.timeline.log({
      type: 'camera',
      actor: this.actor.key,
      wall: Date.now(),
      rect,
      ...(options.zoom ? { zoom: options.zoom } : {}),
      ms,
      ease: options.ease ?? 'smooth',
    });
    if (options.wait !== false) await this.actor.page.waitForTimeout(ms);
  }
}

async function resolveRect(target: Locator | Locator[] | Rect): Promise<Rect> {
  if (!Array.isArray(target) && 'w' in target) return target;
  const boxes = await Promise.all(
    (Array.isArray(target) ? target : [target]).map((l) => l.boundingBox())
  );
  const real = boxes.filter((b): b is NonNullable<typeof b> => b !== null);
  if (real.length === 0) throw new Error('camera.focus: target is not visible');
  const x = Math.min(...real.map((b) => b.x));
  const y = Math.min(...real.map((b) => b.y));
  const r = Math.max(...real.map((b) => b.x + b.width));
  const btm = Math.max(...real.map((b) => b.y + b.height));
  return { x, y, w: r - x, h: btm - y };
}

export class Actor {
  readonly camera: Camera;
  readonly name: string;
  private busy = 0;
  private lastActivity = Date.now();
  private presenceLoop: Promise<void> | null = null;
  private presenceOn = false;

  constructor(
    readonly key: CastKey,
    readonly page: Page,
    readonly context: BrowserContext,
    readonly filmed: boolean,
    readonly timeline: Timeline,
    /** Draw the in-page cursor (false: the edit draws its own from the logged path). */
    readonly showCursor = true
  ) {
    this.camera = new Camera(this, timeline);
    this.name = CAST[key].name;
    observePacing(page, {
      rest: (x, y) => timeline.log({ type: 'cursor', actor: key, wall: Date.now(), x, y }),
      click: (x, y) => timeline.log({ type: 'click', actor: key, wall: Date.now(), x, y }),
      sample: (x, y) => {
        if (filmed)
          timeline.log({
            type: 'pointer',
            actor: key,
            wall: Date.now(),
            x: Math.round(x * 10) / 10,
            y: Math.round(y * 10) / 10,
          });
      },
    });
  }

  /** Navigate and wait out Agor's boot screens (the export cuts them). */
  async open(urlPath: string): Promise<void> {
    await this.page.goto(urlPath);
    // Boot screens are sequential ("Loading...", then "Loading workspace
    // data..."): wait for three quiet checks in a row, not the first gap.
    const loading = this.page.locator('text=/^Loading/');
    const deadline = Date.now() + 90_000;
    let quiet = 0;
    while (Date.now() < deadline && quiet < 3) {
      quiet = (await loading.count().catch(() => 1)) === 0 ? quiet + 1 : 0;
      await this.page.waitForTimeout(400);
    }
    if (this.showCursor) await installCursor(this.page, { ripple: this.filmed });
    await this.page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    setCursorPosition(this.page, VIEWPORT.width / 2, VIEWPORT.height / 2);
    await this.page.waitForTimeout(600);
  }

  /** Run raw Playwright steps as one action (keeps presence nudges out of the way). */
  async act<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    this.busy++;
    try {
      return await fn(this.page);
    } finally {
      this.busy--;
      this.lastActivity = Date.now();
    }
  }

  move(x: number, y: number, ms = 650): Promise<void> {
    return this.act((p) => pacedMove(p, x, y, ms));
  }
  /** One continuous sweep through `points` (viewport px) over `ms`, bending through each. */
  path(points: Array<{ x: number; y: number }>, ms: number): Promise<void> {
    return this.act((p) => pacedPath(p, points, ms));
  }
  /** Drift over `items` (their centers, in order) in one smooth motion over `ms`. */
  async sweep(items: Locator[], ms: number): Promise<void> {
    const boxes = await Promise.all(items.map((l) => l.boundingBox()));
    const points = boxes
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .map((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
    await this.path(points, ms);
  }
  /**
   * Type into a field one key at a time, taking a sharp close-up still of
   * `rect` (viewport px) before the first key and after each one, at
   * `scale` image px per app px (well past the 4K capture's 2). The edit
   * plays these stills for the typing instead of the video, so a tight
   * zoom on the input stays crisp. The video still records the typing,
   * just slowly (each still takes a moment).
   */
  async typeStills(field: Locator, text: string, rect: Rect, scale = 8): Promise<void> {
    await this.click(field);
    await this.act(async (p) => {
      const cdp = await p.context().newCDPSession(p);
      const dpr = await p.evaluate(() => window.devicePixelRatio);
      const dir = path.join(this.timeline.dir, `${this.key}-stills`);
      mkdirSync(dir, { recursive: true });
      const shoot = async (n: number) => {
        // Let the keystroke paint (the caret restarts its blink visible).
        await p.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        );
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 94,
          clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: scale / dpr },
        });
        const file = `${this.key}-stills/${String(n).padStart(3, '0')}.jpg`;
        writeFileSync(path.join(this.timeline.dir, file), Buffer.from(shot.data, 'base64'));
        this.timeline.log({
          type: 'still',
          actor: this.key,
          wall: Date.now(),
          file,
          rect,
          scale,
        });
      };
      await shoot(0);
      for (let i = 0; i < text.length; i++) {
        await p.keyboard.type(text[i]);
        await shoot(i + 1);
      }
      await cdp.detach().catch(() => undefined);
    });
  }
  glideTo(target: Locator, ms?: number): Promise<void> {
    return this.act((p) => glideTo(p, target, ms));
  }
  click(target: Locator, ms?: number): Promise<void> {
    return this.act((p) => glideAndClick(p, target, ms));
  }
  type(field: Locator, text: string): Promise<void> {
    return this.act((p) => typeInto(p, field, text));
  }
  spotlight(target: Locator, dwellMs?: number): Promise<void> {
    return this.act((p) => spotlight(p, target, dwellMs));
  }
  press(key: string): Promise<void> {
    return this.act((p) => p.keyboard.press(key));
  }
  beat(): Promise<void> {
    return beat(this.page);
  }
  settle(): Promise<void> {
    return settle(this.page);
  }
  /** Hold for `ms` at demo pace (shorter in a snappy take). */
  hold(ms: number): Promise<void> {
    return this.page.waitForTimeout(paced(ms));
  }

  /** Press on `from`, carry it by (dx, dy) at a deliberate pace, release. */
  drag(from: Locator, by: { dx: number; dy: number }, ms = 1300): Promise<void> {
    return this.act(async (p) => {
      const box = await from.boundingBox();
      if (!box) throw new Error('drag: source is not visible');
      // Grab near the top edge: a card's header, not a button inside it.
      const x = box.x + box.width / 2;
      const y = box.y + Math.min(14, box.height / 2);
      await pacedMove(p, x, y, 700);
      await p.mouse.down();
      await p.waitForTimeout(120);
      await pacedMove(p, x + by.dx, y + by.dy, ms);
      await p.waitForTimeout(120);
      await p.mouse.up();
    });
  }

  /**
   * Carry `from` onto `to`, landing its top-left corner at `at`, a fraction
   * of the target's size from the target's top-left (default: just inside).
   * Fractions keep a drag correct at any board zoom.
   */
  async dragTo(
    from: Locator,
    to: Locator,
    at: { fx: number; fy: number } = { fx: 0.05, fy: 0.1 },
    ms = 1400
  ): Promise<void> {
    const [src, dst] = await Promise.all([from.boundingBox(), to.boundingBox()]);
    if (!src || !dst) throw new Error('dragTo: source or target is not visible');
    const dx = dst.x + dst.width * at.fx - src.x;
    const dy = dst.y + dst.height * at.fy - src.y;
    await this.drag(from, { dx, dy }, ms);
  }

  /**
   * Another person's live cursor as this actor sees it (its name chip).
   * Agor's cursor layer has no test id; it is the z-index 2000 overlay.
   */
  remoteCursor(key: CastKey): Locator {
    return this.page
      .locator('div[style*="z-index: 2000"] span', { hasText: CAST[key].name })
      .first();
  }

  /** A board node (zone, note, or card) by its visible text. */
  node(text: string): Locator {
    return this.page.locator(`.react-flow__node:has-text("${text}")`).first();
  }

  /** A branch card on the board, by branch name. */
  card(name: string): Locator {
    return this.page.locator(`.react-flow__node:has-text("${name}")`).first();
  }

  /**
   * Keep this actor's live cursor on everyone else's screen: Agor hides a
   * remote cursor after a few idle seconds, so drift a few pixels whenever
   * the actor has been still for a while. On by default for unfilmed actors.
   */
  keepPresent(on = true): void {
    this.presenceOn = on;
    if (!on || this.presenceLoop) return;
    this.presenceLoop = (async () => {
      let flip = 1;
      while (this.presenceOn) {
        await this.page.waitForTimeout(250).catch(() => undefined);
        if (!this.presenceOn || this.page.isClosed()) break;
        if (this.busy > 0 || Date.now() - this.lastActivity < PRESENCE_IDLE_MS) continue;
        const at = cursorPosition(this.page);
        flip = -flip;
        await pacedMove(this.page, at.x + 7 * flip, at.y + 4, 900).catch(() => undefined);
        this.lastActivity = Date.now();
      }
      this.presenceLoop = null;
    })();
  }

  async stopPresence(): Promise<void> {
    this.presenceOn = false;
    await this.presenceLoop;
  }
}

export class Studio {
  readonly world: World;
  readonly actors = new Map<CastKey, Actor>();
  private readonly recorders = new Map<CastKey, FrameRecorder>();
  private rolling = false;

  constructor(
    readonly clipId: string,
    private readonly browser: Browser,
    readonly timeline: Timeline
  ) {
    this.world = readWorld();
  }

  /** Bring a cast member on set: signed in (over REST, never on camera), in their own browser. */
  async actor(
    key: CastKey,
    options: {
      filmed?: boolean;
      /** Keep the live cursor visible to others while idle (default: unfilmed actors). */
      presence?: boolean;
      /** The board's left panel (teammate, sessions, branches, comments). Default collapsed. */
      sidePanel?: 'open' | 'collapsed';
      /**
       * Draw the in-page cursor (default true). A cursorless take still logs
       * every mouse sample, so the edit can draw its own cursor on the path.
       */
      cursor?: boolean;
    } = {}
  ): Promise<Actor> {
    if (this.actors.has(key)) throw new Error(`${key} is already on set`);
    const member = CAST[key];
    const api = await AgorApi.login(member.email, member.password);
    const storage = [
      { name: 'agor-access-token', value: api.session.accessToken },
      // UI preferences the app keeps in localStorage. The board's side panel
      // starts collapsed so the canvas gets the full frame.
      {
        name: 'agor:commentsPanelCollapsed',
        value: JSON.stringify(options.sidePanel !== 'open'),
      },
    ];
    // "Connect Slack, GitHub... via MCP" nudge: snoozed, as if the person had
    // clicked "Maybe later" (the app honors at most 24 hours).
    const userId = this.world.data.users[key]?.id;
    if (userId) {
      storage.push({
        name: `agor:user:${userId}:onboarding:integrations-snoozed-until:v1`,
        value: JSON.stringify(Date.now() + 23 * 3600_000),
      });
    }
    if (api.session.refreshToken) {
      storage.push({ name: 'agor-refresh-token', value: api.session.refreshToken });
    }
    const filmed = options.filmed === true;
    const context = await this.browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      timezoneId: DEMO_TIMEZONE,
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [{ origin: BASE_URL, localStorage: storage }] },
    });
    const page = await context.newPage();
    const actor = new Actor(key, page, context, filmed, this.timeline, options.cursor !== false);
    this.actors.set(key, actor);
    if (filmed) {
      const recorder = new FrameRecorder(page, path.join(this.timeline.dir, `${key}-frames`), {
        width: VIEWPORT.width * SCALE,
        height: VIEWPORT.height * SCALE,
      });
      await recorder.start();
      this.recorders.set(key, recorder);
    }
    this.timeline.log({
      type: 'actor',
      actor: key,
      video: null,
      frames: filmed ? `${key}-frames` : null,
      viewport: VIEWPORT,
      scale: SCALE,
    });
    if (options.presence ?? !filmed) actor.keepPresent();
    return actor;
  }

  /** Action: the finished clip starts here. Call once everyone is on screen and settled. */
  async action(): Promise<void> {
    if (this.rolling) throw new Error('studio.action() called twice');
    this.rolling = true;
    this.timeline.log({ type: 'ready', wall: Date.now() });
  }

  /** A named point in the take, for cutting clips together later. */
  mark(label: string): void {
    this.timeline.log({ type: 'mark', label, wall: Date.now() });
  }

  /** Cut: end the take. Called by the fixture; call it yourself to end early. */
  async cut(): Promise<void> {
    if (!this.rolling) return;
    this.rolling = false;
    this.timeline.log({ type: 'end', wall: Date.now() });
  }

  async wrap(passed: boolean): Promise<void> {
    await this.cut();
    for (const actor of this.actors.values()) await actor.stopPresence();
    // Every frame on disk before anything closes.
    for (const recorder of this.recorders.values()) await recorder.stop();
    // The end state, for clips that pick up where this one left off.
    if (passed) snapshotCheckpoint(`post-${this.clipId}`);
    for (const actor of this.actors.values()) await actor.context.close();
  }
}

/**
 * Declare a clip spec. The id must match a CLIPS entry (support/clips.ts)
 * and the spec's filename (tests/clips/<id>.spec.ts).
 */
export function clip(id: string, body: (args: { studio: Studio }) => Promise<void>): void {
  const meta = clipById(id);
  const test = base.extend<{ studio: Studio }>({
    studio: async ({ browser }, use, testInfo) => {
      const dir = takeDir(id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const studio = new Studio(id, browser, new Timeline(dir));
      await use(studio);
      await studio.wrap(testInfo.status === testInfo.expectedStatus);
    },
  });
  test(`clip: ${id}: ${meta.title}`, async ({ studio }) => {
    test.setTimeout(meta.timeoutMs ?? 300_000);
    await body({ studio });
  });
}

/** True when the take directory holds a finished take (used by clip.ts). */
export function hasTake(id: string): boolean {
  const dir = takeDir(id);
  return (
    existsSync(path.join(dir, 'timeline.jsonl')) &&
    readFileSync(path.join(dir, 'timeline.jsonl'), 'utf8').includes('"type":"end"')
  );
}
