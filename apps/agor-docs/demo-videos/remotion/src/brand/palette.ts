// agor.live's dark palette (apps/agor-docs/components/LandingPage.module.css
// on main): near-black green backgrounds, mint-white ink, and the teal
// green / teal / aqua / sky-blue range.

export const BG = '#07100f';
/** The site's page background, top to bottom. */
export const BG_GRADIENT =
  'linear-gradient(180deg, #07100f 0%, #0a1614 36%, #081210 72%, #07100f 100%)';
export const INK = '#eafff9';
export const MUTED = '#9fc4bd';
/** Dark text on the bright fills. */
export const ON_FILL = '#07100f';

export const GREEN = '#2ea78f';
export const TEAL = '#34e6c4';
export const AQUA = '#a8f5ed';
export const SKY = '#7ad9ff';

// Rich fills for big color blocks (slices, panels): the site's green and
// teal, deepening into the blue and indigo of its teammates ring. White ink
// reads on all of them.
export const FILL_GREEN = 'linear-gradient(160deg, #1f7c68 0%, #2ea78f 100%)';
export const FILL_TEAL = 'linear-gradient(160deg, #2a8f88 0%, #45c4bb 100%)';
export const FILL_BLUE = 'linear-gradient(160deg, #2560b4 0%, #3d8fe0 100%)';
export const FILL_INDIGO = 'linear-gradient(160deg, #3b3caa 0%, #5d5ee0 100%)';

/** The site's heading accent (gradient text): teal to sky. */
export const ACCENT_GRADIENT = 'linear-gradient(110deg, #34e6c4, #7ad9ff)';
/** Gradient text, as a style. */
export const gradientText = (gradient: string) =>
  ({
    background: gradient,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  }) as const;
