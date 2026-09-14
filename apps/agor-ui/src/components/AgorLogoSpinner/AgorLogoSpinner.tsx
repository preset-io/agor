import './AgorLogoSpinner.css';

/* Agor logo brand teal — explicit brand asset color, overridable via `color`. */
// biome-ignore lint/plugin/noHardcodedColorLiteral: the logo's brand color is an explicit brand asset, not a themeable surface
const BRAND_TEAL = '#36B7AF';

/* Geometry shared with the animated logo reveal
   (apps/agor-docs/demo-videos/animated_agor_logo): 734×734 viewBox, 29px
   strokes, dots r=40 on a 297 orbit, inner ring r=189, centered at 367,367. */
const A_PATH =
  'M188,607 C188,607 306.427,380.615 351.693,294.083 C355.033,287.698 361.66,283.713 368.865,283.756 C376.071,283.799 382.649,287.862 385.914,294.286 C420.058,361.482 494,507 494,507';
const CROSSBAR_PATH =
  'M293.84,404.67 C307.45,431.55 335.34,450 367.5,450 C400,450 428.13,431.17 441.58,403.83';
const TAIL_PATHS = ['M367,70 A297,297 0 0,0 188,607', 'M367,664 A297,297 0 0,0 664,367'];
const DOTS = [
  { cx: 367, cy: 70 },
  { cx: 367, cy: 664 },
  { cx: 188, cy: 607 },
  { cx: 664, cy: 367 },
];

interface Props {
  /** Rendered width/height in px. */
  size?: number;
  /** Stroke/fill color; defaults to the logo's brand teal. */
  color?: string;
  'aria-label'?: string;
}

/**
 * The Agor logo as an indeterminate loading spinner: the A holds still while
 * the inner ring sweeps like a conventional spinner and the outer dots orbit
 * with their connecting arcs collapsing and re-extending behind them. Pure
 * CSS animation — no timers, no measurement. Honors prefers-reduced-motion by
 * resting as the complete static logo.
 */
export function AgorLogoSpinner({ size = 96, color = BRAND_TEAL, ...rest }: Props) {
  return (
    <svg
      className="agor-logo-spinner"
      width={size}
      height={size}
      viewBox="0 0 734 734"
      role="img"
      aria-label={rest['aria-label'] ?? 'Loading'}
      style={{ color, display: 'block' }}
      fill="none"
      stroke="currentColor"
      strokeWidth={29}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={CROSSBAR_PATH} />
      <path d={A_PATH} />
      <circle className="agor-logo-spinner-ring" cx={367} cy={367} r={189} pathLength={100} />
      <g className="agor-logo-spinner-orbit">
        {TAIL_PATHS.map((d, index) => (
          <path
            key={d}
            className={`agor-logo-spinner-tail${index === 1 ? ' agor-logo-spinner-tail-alt' : ''}`}
            d={d}
            pathLength={100}
          />
        ))}
        {DOTS.map(({ cx, cy }) => (
          <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={40} fill="currentColor" stroke="none" />
        ))}
      </g>
    </svg>
  );
}
