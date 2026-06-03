/**
 * Cursor model constants shared by daemon, executor, MCP, and browser UI.
 *
 * Cursor can return an account-specific live model list via the SDK, but the
 * fallback/default alias is static and safe to share across packages.
 */
export const DEFAULT_CURSOR_MODEL = 'composer-latest';

export const CURSOR_MODEL_METADATA = {
  [DEFAULT_CURSOR_MODEL]: {
    displayName: 'Composer Latest',
    description: 'Cursor SDK default model alias (experimental)',
  },
} as const;
