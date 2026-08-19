// biome-ignore-all lint/plugin/noHardcodedColorLiteral: centralized user-selectable board background palette stores exact persisted gradients

import { GOLD_SHIMMER_BOARD_BACKGROUND } from '@agor/core/design/board-backgrounds';

export interface BackgroundPreset {
  /** Stable identifier used for React keys and selection. */
  id: string;
  /** Human-readable name shown under the thumbnail. */
  label: string;
  /** The exact CSS `background` value persisted to `background_color`. */
  value: string;
  /** Whether the preset reads as a dark or light surface (for the tone badge). */
  tone: 'dark' | 'light';
}

/**
 * Curated, sober background gallery.
 *
 * Deliberately restrained: mostly deep, low-saturation surfaces with a single
 * quiet accent so cards, zones, and edges stay legible on top. The previous
 * loud/dated entries (rainbow, RGB stripes, hairline B&W lines, checkerboard,
 * conic sunbursts) were dropped for contrast/readability reasons. Gold Shimmer
 * is retained at the end so boards that historically carried it can pin it back
 * explicitly.
 */
export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'midnight',
    label: 'Midnight',
    tone: 'dark',
    value:
      'radial-gradient(70% 50% at 50% -6%, rgba(99, 122, 179, 0.28) 0%, rgba(99, 122, 179, 0) 60%), linear-gradient(180deg, #10141f 0%, #0b0e17 60%, #080a11 100%)',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    tone: 'dark',
    value: 'linear-gradient(180deg, #232830 0%, #171a20 55%, #101318 100%)',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    tone: 'dark',
    value:
      'radial-gradient(65% 55% at 50% -8%, rgba(56, 189, 168, 0.24) 0%, rgba(56, 189, 168, 0) 60%), radial-gradient(50% 45% at 85% 105%, rgba(59, 130, 190, 0.18) 0%, rgba(59, 130, 190, 0) 60%), linear-gradient(180deg, #0c1418 0%, #080f12 100%)',
  },
  {
    id: 'nebula',
    label: 'Nebula',
    tone: 'dark',
    value:
      'radial-gradient(60% 50% at 22% 18%, rgba(130, 80, 220, 0.30) 0%, rgba(130, 80, 220, 0) 55%), radial-gradient(55% 50% at 82% 88%, rgba(210, 70, 160, 0.22) 0%, rgba(210, 70, 160, 0) 55%), linear-gradient(180deg, #12101c 0%, #0b0912 100%)',
  },
  {
    id: 'ember',
    label: 'Ember',
    tone: 'dark',
    value:
      'radial-gradient(70% 55% at 50% -6%, rgba(214, 140, 74, 0.22) 0%, rgba(214, 140, 74, 0) 60%), linear-gradient(180deg, #17120e 0%, #0f0b08 100%)',
  },
  {
    id: 'fog',
    label: 'Fog',
    tone: 'light',
    value:
      'radial-gradient(80% 60% at 50% -10%, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0) 60%), linear-gradient(180deg, #eef2f7 0%, #dfe6ef 100%)',
  },
  {
    id: 'dawn',
    label: 'Dawn',
    tone: 'light',
    value:
      'radial-gradient(80% 60% at 50% -10%, rgba(255, 240, 224, 0.95) 0%, rgba(255, 240, 224, 0) 60%), linear-gradient(180deg, #fbf3ec 0%, #f2e7dd 100%)',
  },
  {
    id: 'gold-shimmer',
    label: 'Gold Shimmer',
    tone: 'dark',
    value: GOLD_SHIMMER_BOARD_BACKGROUND,
  },
];

/** Lookup a preset by its persisted CSS value. */
export function findPresetByValue(value: string | undefined | null): BackgroundPreset | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return BACKGROUND_PRESETS.find((preset) => preset.value === trimmed);
}

export interface AnimationPreset {
  label: string;
  value: string;
}

/**
 * Optional animation CSS — each sets background-size + animation + @keyframes.
 * Pairs with any gradient background. Applied only in Custom mode; disabled
 * automatically for users who prefer reduced motion (see SessionCanvas).
 */
export const ANIMATION_PRESETS: AnimationPreset[] = [
  {
    label: 'Slow gradient shift (12s)',
    value: `background-size: 400% 400%;
animation: agorGradientShift 12s ease infinite;

@keyframes agorGradientShift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}`,
  },
  {
    label: 'Fast gradient shift (4s)',
    value: `background-size: 400% 400%;
animation: agorGradientFast 4s ease infinite;

@keyframes agorGradientFast {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}`,
  },
  {
    label: 'Diagonal sweep (8s)',
    value: `background-size: 400% 400%;
animation: agorDiagonalSweep 8s linear infinite;

@keyframes agorDiagonalSweep {
  0% { background-position: 0% 0%; }
  50% { background-position: 100% 100%; }
  100% { background-position: 0% 0%; }
}`,
  },
  {
    label: 'Pulse zoom (6s)',
    value: `background-size: 200% 200%;
animation: agorPulse 6s ease-in-out infinite;

@keyframes agorPulse {
  0%, 100% { background-size: 200% 200%; background-position: center; }
  50% { background-size: 300% 300%; background-position: center; }
}`,
  },
  {
    label: 'Horizontal scroll (20s)',
    value: `background-size: 200% 100%;
animation: agorHScroll 20s linear infinite;

@keyframes agorHScroll {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}`,
  },
  {
    label: 'Hue rotate (10s)',
    value: `animation: agorRotate 10s linear infinite;

@keyframes agorRotate {
  0% { filter: hue-rotate(0deg); }
  100% { filter: hue-rotate(360deg); }
}`,
  },
];
