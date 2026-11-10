/**
 * Write-time shape checks for the style fields of canvas board objects.
 *
 * Board objects are authored by board editors, MCP callers and imports, and are
 * rendered for every viewer of the board, so size and color fields must hold
 * plain values rather than arbitrary CSS text.
 */

const NUMERIC_STYLE_FIELDS = ['width', 'height', 'fontSize', 'zIndex'] as const;
const COLOR_STYLE_FIELDS = ['color', 'background', 'borderColor', 'backgroundColor'] as const;

/** Hex, a named color, or a color function with plain numeric/keyword arguments. */
const CSS_COLOR =
  /^(#[0-9a-f]{3,8}|[a-z]+|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([\w\s#.,%/+-]*\))$/i;
const MAX_COLOR_LENGTH = 100;

function isSafeCssColor(value: unknown): boolean {
  return (
    typeof value === 'string' && value.length <= MAX_COLOR_LENGTH && CSS_COLOR.test(value.trim())
  );
}

/**
 * Why a board object's style fields are unusable, or null when they are fine.
 * A field equal to its value in `previous` (the stored object) is not rechecked.
 */
export function boardObjectStyleError(object: unknown, previous?: unknown): string | null {
  if (!object || typeof object !== 'object') return null;
  const record = object as Record<string, unknown>;
  const stored = (previous && typeof previous === 'object' ? previous : {}) as Record<
    string,
    unknown
  >;
  const changed = (field: string) => record[field] != null && record[field] !== stored[field];
  for (const field of NUMERIC_STYLE_FIELDS) {
    const value = record[field];
    if (changed(field) && !(typeof value === 'number' && Number.isFinite(value))) {
      return `${field} must be a finite number`;
    }
  }
  for (const field of COLOR_STYLE_FIELDS) {
    if (changed(field) && !isSafeCssColor(record[field])) {
      return `${field} must be a CSS color (hex, name, or color function)`;
    }
  }
  return null;
}
