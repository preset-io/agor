// biome-ignore-all lint/plugin/noHardcodedColorLiteral: centralized persisted board-background gradient literals

/**
 * Gold-shimmer gradient. Historically this was force-persisted as the default
 * `background_color` on every board at creation time; that behavior has been
 * removed (new boards persist no background and render the theme-aware
 * default). It remains a selectable preset in the gallery so anyone can pick it
 * back explicitly, and so boards that still carry it render exactly as stored.
 */
export const GOLD_SHIMMER_BOARD_BACKGROUND =
  'linear-gradient(135deg, #f5af19 0%, #f12711 30%, #f5af19 60%, #f12711 100%)';

export const GOLD_SHIMMER_BOARD_BACKGROUND_PRESET = {
  label: 'Gold Shimmer',
  value: GOLD_SHIMMER_BOARD_BACKGROUND,
} as const;
