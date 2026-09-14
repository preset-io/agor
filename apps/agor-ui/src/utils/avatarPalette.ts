// biome-ignore-all lint/plugin/noHardcodedColorLiteral: centralized categorical avatar-tile palette (muted mid-tones, tuned to Agor) — not expressible as semantic theme tokens
import type { User } from '@agor-live/client';

/**
 * Muted, modern avatar palette (Mixpanel-ish, tuned to Agor). A centralized
 * categorical tile palette is an allowed exact-color exception per
 * context/guidelines/frontend.md — these mid-tones can't be expressed with
 * semantic theme tokens, and contrast-aware text keeps initials legible.
 *
 * This is the single source of truth for categorical accent colors: user/
 * teammate avatars key off it via getUserAvatarColor, and the teammate gallery
 * categories reuse specific entries (see TEMPLATE_CATEGORIES) rather than
 * inventing new hues.
 */
export const AVATAR_PALETTE = [
  '#6E7BA6', // 0 muted indigo
  '#5B8A8F', // 1 muted teal
  '#7E9A6B', // 2 sage
  '#A6767E', // 3 dusty rose
  '#8A7BA6', // 4 mauve-purple
  '#B0916A', // 5 warm sand
  '#6C89A6', // 6 dusty blue
  '#9A7B9E', // 7 muted mauve
];

/** Deterministic palette color keyed off a stable user identifier. */
export function getUserAvatarColor(
  user: Pick<User, 'user_id' | 'email' | 'name'> | null | undefined
): string {
  const key = user?.user_id || user?.email || user?.name || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}
