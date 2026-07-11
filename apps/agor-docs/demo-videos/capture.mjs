// Frame-stepped capture of the /demo/marketing-video fixture.
//
// The fixture owns ALL motion on a virtual clock; this script never interacts
// in real time. Per frame it calls window.__agorDemo.setTime(ms), waits a
// triple-rAF settle (store write → React render → node-sync effect → paint),
// and screenshots. Frames land in frames/<scene>/f%05d.png at 2x scale
// (3840×2160) ready for encode.sh.
//
// Usage:
//   node capture.mjs                         # all scenes
//   node capture.mjs --scene multiplayer     # one scene
//   node capture.mjs --scene multiplayer --frame 120   # single debug frame
//   node capture.mjs --base-url http://localhost:5173  # dev server override
//
// Requires the agor-ui dev server running (pnpm --filter agor-ui dev) and
// network access for the Sandpack bundler (codesandbox.io).

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const VIEWPORT = { width: 1920, height: 1080 };
const DEVICE_SCALE_FACTOR = 2;

// Floor waits give the Sandpack iframes (remote bundler) time to paint after
// the page reports ready. Scenes without visible Sandpack content can go
// shorter, but every scene shows the board, so keep a generous floor.
const SCENES = {
  multiplayer: { floorMs: 6_000 },
  // Session panel covers the Sandpack nodes; short floor is enough.
  session: { floorMs: 4_000 },
  artifact: { floorMs: 10_000 },
  settings: { floorMs: 6_000 },
  // Showcase-carousel scenes (landing page "So much more than a chat box").
  // boards shows the whole board incl. Sandpack apps → generous floor.
  // multiplayer's framing shows only the Ship zone (no Sandpack in frame)
  // and gateway covers the canvas entirely (Slack stage + session panel).
  boards: { floorMs: 10_000 },
  sessions: { floorMs: 6_000 },
  gateway: { floorMs: 5_000 },
};

const parseArgs = (argv) => {
  const args = {
    scene: 'all',
    frame: null,
    baseUrl: 'http://localhost:5173',
    dsf: DEVICE_SCALE_FACTOR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scene') args.scene = argv[++i];
    else if (argv[i] === '--frame') args.frame = Number(argv[++i]);
    else if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    // Frame pixel density. The viewport stays 1920×1080 (scene choreography
    // is authored in that coordinate space) — use --dsf 1 for the showcase
    // renditions (1600×900 output) so frames stay ~4× smaller than 4K.
    else if (argv[i] === '--dsf') args.dsf = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
};

const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
  );

const captureScene = async (browser, name, config, args) => {
  const framesDir = path.join(HERE, 'frames', name);
  if (args.frame === null) {
    await rm(framesDir, { recursive: true, force: true });
  }
  await mkdir(framesDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: args.dsf,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`[${name}] page error:`, error.message));

  const url = `${args.baseUrl}/demo/marketing-video?scene=${name}`;
  console.log(`[${name}] loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__agorDemo?.isReady() === true, { timeout: 60_000 });
  console.log(`[${name}] fixture ready; waiting ${config.floorMs}ms for Sandpack to paint`);
  await page.waitForTimeout(config.floorMs);

  const durationMs = await page.evaluate(() => window.__agorDemo.getDuration());
  const totalFrames = Math.round((durationMs / 1000) * FPS);
  const frames =
    args.frame === null ? Array.from({ length: totalFrames }, (_, i) => i) : [args.frame];

  console.log(`[${name}] capturing ${frames.length}/${totalFrames} frames at ${FPS}fps`);
  const startedAt = Date.now();
  for (const i of frames) {
    const ms = (i / FPS) * 1000;
    await page.evaluate((time) => window.__agorDemo.setTime(time), ms);
    await settle(page);
    await page.screenshot({
      path: path.join(framesDir, `f${String(i).padStart(5, '0')}.png`),
    });
    if (i > 0 && i % 30 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`[${name}]   frame ${i}/${totalFrames} (${elapsed}s elapsed)`);
    }
  }

  await context.close();
  console.log(`[${name}] done → ${framesDir}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const sceneNames = args.scene === 'all' ? Object.keys(SCENES) : [args.scene];
  for (const name of sceneNames) {
    if (!SCENES[name]) {
      console.error(`Unknown scene "${name}". Known: ${Object.keys(SCENES).join(', ')}`);
      process.exit(1);
    }
  }

  const browser = await chromium.launch();
  try {
    for (const name of sceneNames) {
      await captureScene(browser, name, SCENES[name], args);
    }
  } finally {
    await browser.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
