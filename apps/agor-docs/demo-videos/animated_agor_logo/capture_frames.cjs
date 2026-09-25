// 4K frame-by-frame capture of index_4k.html for the Agor logo reveal.
//
// Loads with "#0" in the URL so the page's own onload handler calls
// scrubTo(0) instead of play() — if we let play() run even briefly before
// our first per-frame freeze, the animation's real-time clock keeps ticking
// underneath our override (changing animation-delay on an already-running
// animation shifts it, it doesn't reset it to zero), baking a hidden head
// start into every subsequent frame. Loading pre-paused at exactly 0 avoids
// that entirely.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const width = 3840,
    height = 2160;
  const fps = 30;
  const totalDuration = 6.8; // seconds
  const buildDuration = 4.5; // matches the page's own build animation duration
  const frameDir = path.join(__dirname, 'pngframes');
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto('file://' + path.join(__dirname, 'index_4k.html') + '#0');
  await page.waitForTimeout(300);

  const numFrames = Math.round(totalDuration * fps);
  for (let i = 0; i < numFrames; i++) {
    const t = i / fps;
    await page.evaluate(
      ({ t, buildDuration }) => {
        const svg = document.querySelector('svg');
        svg.querySelectorAll('.arm,.dot,.drawable,.crossbar').forEach((el) => {
          el.style.animationDelay = -t + 's';
          el.style.animationPlayState = 'paused';
        });
        const shine = svg.querySelector('.shine');
        if (shine) {
          shine.style.animationDelay = buildDuration - t + 's';
          shine.style.animationPlayState = 'paused';
        }
      },
      { t, buildDuration }
    );
    const frameName = `frame_${String(i).padStart(5, '0')}.png`;
    await page.screenshot({ path: path.join(frameDir, frameName) });
    if (i % 20 === 0) console.log(`frame ${i}/${numFrames}`);
  }

  await browser.close();
  console.log('done, frames in', frameDir);
})();
