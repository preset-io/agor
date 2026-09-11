// Stand-in marketing capture: drives the LIVE agor.live homepage with the
// syllabus pacing grammar (eased cursor arcs, smooth scrolls, dwells) and
// records it with the quality-patched Playwright pipeline. Shot list from
// Evan (2026-08-31), section by section; the logo reveal is prepended and
// appended (reversed) by scripts/stitch-agorlive.ts afterwards.
//
//   npx tsx scripts/capture-agorlive.ts [https://agor.live]
//
// Live-site CSS-module classes are hashed, so every selector matches with
// [class*="..."] on the stable style names from components/LandingPage.tsx.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Locator, type Page } from '@playwright/test';
import { SCRATCH_DIR } from '../support/harness.ts';
import { pacedMove } from '../support/pacing.ts';

// Default to a LOCAL docs dev server (all homepage media lives in
// public/videos — served instantly, nothing streams on camera):
//   cd apps/agor-docs && npx next dev -p 3901
const SITE = process.argv[2] ?? 'http://localhost:3901';
const OUT_DIR = path.join(SCRATCH_DIR, 'agorlive-capture');

function sec(page: Page, styleName: string): Locator {
  return page.locator(`section[class*="${styleName}"]`).first();
}

/** Smooth-scroll a section's top to the top of the viewport and settle. */
async function showSection(page: Page, target: Locator, settleMs = 1600): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await page.waitForTimeout(settleMs);
}

/** Duration (s) of the first playing/visible <video> inside a locator. */
async function videoDuration(scope: Locator): Promise<number | null> {
  const vid = scope.locator('video').first();
  if ((await vid.count()) === 0) return null;
  return vid.evaluate((v: HTMLVideoElement) =>
    Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    colorScheme: 'dark',
    recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const recStart = Date.now(); // video recording starts with the page

  // Pre-warm: load once so the hero/slide videos land in the HTTP cache,
  // nudge every <video> to fetch, then reload — the recorded pass paints
  // instantly instead of streaming media on camera.
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (const v of Array.from(document.querySelectorAll('video'))) {
      v.preload = 'auto';
      v.load();
    }
    await new Promise((r) => setTimeout(r, 6000));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // Hold until the hero video can actually play through.
  await page
    .waitForFunction(
      () => {
        const v = document.querySelector('section video') as HTMLVideoElement | null;
        return !v || v.readyState >= 3;
      },
      { timeout: 20_000 }
    )
    .catch(() => undefined);
  // Everything up to here is warm-up, not footage — record where the
  // show starts so the stitcher can trim to it exactly.
  writeFileSync(
    path.join(OUT_DIR, 'trim.json'),
    JSON.stringify({ trimSeconds: (Date.now() - recStart) / 1000 })
  );
  // This variant is chrome-free footage: hide the site nav entirely, and
  // no cursor overlay (unlike the tutorial videos, the pointer is not part
  // of the story here — paced moves still drive hovers invisibly).
  await page.addStyleTag({
    content:
      'header,nav,[class*="navbar"],[class*="nx-nav"]{display:none!important;}' +
      'section{scroll-margin-top:24px;}',
  });
  await page.mouse.move(960, 540);

  // ── Hero: let the background video play through once. ────────────────
  const hero = sec(page, 'heroSection');
  await showSection(page, hero, 800);
  const heroDur = (await videoDuration(hero)) ?? 8;
  const heroVid = hero.locator('video').first();
  if ((await heroVid.count()) > 0) {
    await heroVid.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0;
      return v.play().catch(() => undefined);
    });
  }
  await pacedMove(page, 1180, 620, 1200);
  await page.waitForTimeout(Math.min(heroDur, 25) * 1000);

  // ── "Don't let AI silo your team": reveal, then hold 8s. ─────────────
  const problem = sec(page, 'problemSection');
  await showSection(page, problem);
  await page.waitForTimeout(8_000);

  // ── "So much more than a chat box": each slide min(video, 5s). ───────
  const showcase = sec(page, 'showcaseSection');
  await showSection(page, showcase);
  const showcaseTabs = showcase.locator('button[class*="showcaseTab"]');
  const showcaseCount = await showcaseTabs.count();
  for (let i = 0; i < showcaseCount; i++) {
    const tab = showcaseTabs.nth(i);
    const box = await tab.boundingBox();
    if (box) {
      await pacedMove(page, box.x + box.width / 2, box.y + box.height / 2, 700);
      await tab.click();
    }
    await page.waitForTimeout(400); // slide transition
    // Let the slide's video become playable before the dwell clock starts.
    await showcase
      .locator('video')
      .first()
      .evaluate((v: HTMLVideoElement) =>
        v.readyState >= 3
          ? undefined
          : new Promise<void>((resolve) => {
              v.addEventListener('canplay', () => resolve(), { once: true });
              setTimeout(resolve, 4000);
            })
      )
      .catch(() => undefined);
    const dur = await videoDuration(showcase);
    await page.waitForTimeout(Math.min(dur ?? 5, 5) * 1000);
  }

  // ── "Raise AI teammates": hover/click each ring circle for 3s. ───────
  const workspace = sec(page, 'workspaceSection');
  await showSection(page, workspace);
  const nodes = workspace.locator('button[class*="ringNode"]');
  const nodeCount = await nodes.count();
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes.nth(i);
    const box = await node.boundingBox();
    if (!box) continue;
    await pacedMove(page, box.x + box.width / 2, box.y + box.height / 2, 800);
    await node.hover().catch(() => undefined);
    await node.click().catch(() => undefined);
    await page.waitForTimeout(3_000);
  }

  // ── "Every capability AI enablers need": 3s per slide. ───────────────
  const product = sec(page, 'productShowcase');
  await showSection(page, product);
  const productTabs = product.locator('button[class*="showcaseTab"]');
  const productCount = await productTabs.count();
  for (let i = 0; i < productCount; i++) {
    const tab = productTabs.nth(i);
    const box = await tab.boundingBox();
    if (box) {
      await pacedMove(page, box.x + box.width / 2, box.y + box.height / 2, 700);
      await tab.click();
    }
    await page.waitForTimeout(3_000);
  }

  // ── "You're using AI / Now make it compound": 10s. ───────────────────
  await showSection(page, sec(page, 'controlSection'));
  await page.waitForTimeout(10_000);

  // ── "Set your team free from the terminal": shim full-height, 5s. ────
  await page.addStyleTag({
    content: 'section[class*="liveSection"]{min-height:100vh;box-sizing:border-box;}',
  });
  await showSection(page, sec(page, 'liveSection'));
  await page.waitForTimeout(5_000);

  // ── "Full agentic coverage for any org": 8s. ─────────────────────────
  await showSection(page, sec(page, 'rosterSection'));
  await page.waitForTimeout(8_000);

  await context.close(); // flushes the video
  await browser.close();
  console.log(`[capture-agorlive] video in ${OUT_DIR}`);
}

await main();
