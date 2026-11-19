// Scene — "marketplace" (8s, loop-perfect, booth-loop candidate).
// The real Marketplace catalog (CatalogTab, backed by the stub AgorClient in
// demoMarketplaceClient.ts) browsed end to end: open Clerk's detail drawer,
// pick a branch, acknowledge the access disclosure, and press Connect — the
// REAL handleConnect request/response flow runs, and the drawer closes on
// success exactly like production. See DemoMarketplaceStage.tsx for why this
// is the real component tree rather than a staged recreation.
// Tune via /demo/marketing-video?scene=marketplace&play=1

import { clickPulses, type SceneDefinition, Track } from '../timeline';

const DURATION = 8_000;

/** The catalog grid's first card ("Clerk" — auth_type: none, listed first in
 * DEMO_CATALOG_ENTRIES) opens its detail drawer. */
const openClerkCard = () => {
  const card = document.querySelector<HTMLElement>('[aria-label^="Open Clerk"]');
  card?.click();
};

/** Open the drawer's Branch Select dropdown (antd 6 Select opens on
 * mousedown on the `.ant-select` root; matches settings.ts's approach). */
const openBranchSelect = () => {
  const drawer = document.querySelector('.ant-drawer-body');
  const item = Array.from(drawer?.querySelectorAll<HTMLElement>('.ant-form-item') ?? []).find(
    (candidate) => candidate.querySelector('.ant-form-item-label')?.textContent?.includes('Branch')
  );
  const select = item?.querySelector<HTMLElement>('.ant-select');
  select?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
};

/** Click the landing-hero-polish option in the open branch dropdown. */
const pickBranchOption = () => {
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  const target = options.find((option) => option.textContent?.includes('landing-hero-polish'));
  target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  target?.click();
};

/** Check the "I understand what this server can access" disclosure box. */
const acknowledgeDisclosure = () => {
  const drawer = document.querySelector('.ant-drawer-body');
  const checkbox = drawer?.querySelector<HTMLElement>('.ant-checkbox-wrapper');
  checkbox?.click();
};

/** Press Connect — runs the real handleConnect flow against the stub client. */
const clickConnect = () => {
  const drawer = document.querySelector('.ant-drawer-body');
  const button = drawer?.querySelector<HTMLElement>('.ant-btn-primary');
  button?.click();
};

export const marketplaceScene: SceneDefinition = {
  name: 'marketplace',
  durationMs: DURATION,
  viewport: new Track([{ t: 0, v: { x: 109, y: 0, zoom: 0.56 } }]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    marketplaceOpen: new Track([{ t: 0, v: 1 }]),
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 960 },
      { t: 900, v: 330 },
      { t: 1_150, v: 330, easing: 'hold' },
      { t: 1_700, v: 830 },
      { t: 1_850, v: 830, easing: 'hold' },
      { t: 2_150, v: 830 },
      { t: 2_300, v: 830, easing: 'hold' },
      { t: 2_700, v: 700 },
      { t: 2_850, v: 700, easing: 'hold' },
      { t: 3_300, v: 1_040 },
      { t: 3_450, v: 1_040, easing: 'hold' },
    ]),
    pointerY: new Track([
      { t: 0, v: 600 },
      { t: 900, v: 300 },
      { t: 1_150, v: 300, easing: 'hold' },
      { t: 1_700, v: 500 },
      { t: 1_850, v: 500, easing: 'hold' },
      { t: 2_150, v: 570 },
      { t: 2_300, v: 570, easing: 'hold' },
      { t: 2_700, v: 700 },
      { t: 2_850, v: 700, easing: 'hold' },
      { t: 3_300, v: 830 },
      { t: 3_450, v: 830, easing: 'hold' },
    ]),
    pointerRipple: clickPulses([1_150, 1_850, 2_300, 2_850, 3_450]),
  },
  actions: [
    { t: 1_150, run: openClerkCard },
    { t: 1_850, run: openBranchSelect },
    { t: 2_300, run: pickBranchOption },
    { t: 2_850, run: acknowledgeDisclosure },
    { t: 3_450, run: clickConnect },
  ],
};
