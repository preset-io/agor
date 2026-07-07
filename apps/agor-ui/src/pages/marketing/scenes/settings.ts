// Scene 3 — "session settings" (4s).
// A pointer opens the session settings modal over a zoomed branch card, opens
// the Reasoning Effort dropdown (showing the effort descriptions), picks
// X-High, and closes. The modal itself is driven by the `settingsOpen` flag;
// the dropdown + option are REAL clicks fired by action keyframes, so the
// antd Select behaves exactly like production.
// Tune via /demo/marketing-video?scene=settings&play=1

import { clickPulses, type SceneDefinition, Track } from '../timeline';

const DURATION = 4_000;

// Backdrop: zoom on the landing-hero-polish branch card, abs ≈ (130,760),
// card center ≈ (340,950). Pane center (960,508), zoom 1.05.
const VIEWPORT = { x: 603, y: -490, zoom: 1.05 };

/** Open the effort Select's dropdown (antd 6 Select opens on mousedown on the
 * .ant-select root; there is no .ant-select-selector in the v6 DOM). */
const clickEffortSelect = () => {
  const items = Array.from(document.querySelectorAll<HTMLElement>('.ant-form-item'));
  const effortItem = items.find((item) =>
    item.querySelector('.ant-form-item-label')?.textContent?.includes('Reasoning Effort')
  );
  const select = effortItem?.querySelector<HTMLElement>('.ant-select');
  select?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
};

/** Click the X-High option in the open effort dropdown. */
const clickEffortOption = () => {
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  const target = options.find((option) => option.textContent?.includes('X-High'));
  target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  target?.click();
};

export const settingsScene: SceneDefinition = {
  name: 'settings',
  durationMs: DURATION,
  viewport: new Track([{ t: 0, v: VIEWPORT }]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    settingsOpen: new Track([
      { t: 0, v: 0 },
      { t: 500, v: 1, easing: 'hold' },
      { t: 3_900, v: 0, easing: 'hold' },
    ]),
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 480 },
      { t: 450, v: 640 },
      { t: 1_300, v: 820 },
      { t: 1_500, v: 820, easing: 'hold' },
      { t: 1_900, v: 790 },
      { t: 2_400, v: 795 },
      { t: 2_750, v: 795, easing: 'hold' },
      { t: 3_500, v: 1_145 },
    ]),
    pointerY: new Track([
      { t: 0, v: 280 },
      { t: 450, v: 430 },
      { t: 1_300, v: 505 },
      { t: 1_500, v: 505, easing: 'hold' },
      { t: 1_900, v: 595 },
      { t: 2_400, v: 695 },
      { t: 2_750, v: 695, easing: 'hold' },
      { t: 3_500, v: 945 },
    ]),
    pointerRipple: clickPulses([470, 1_500, 2_800, 3_800]),
  },
  actions: [
    { t: 1_520, run: clickEffortSelect },
    { t: 2_820, run: clickEffortOption },
  ],
};
