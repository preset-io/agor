/**
 * HTML escaping utilities for rendering user-facing HTML strings from
 * custom Express routes (OAuth callbacks, GitHub App install, etc.).
 *
 * NOTE: prefer a real templating library if you reach for this more than
 * a handful of times — this is a targeted helper, not a rendering engine.
 */

/**
 * Escape a value for safe insertion into HTML text or quoted-attribute
 * contexts. Covers the five characters required by both contexts:
 * `&`, `<`, `>`, `"`, `'`.
 *
 * Do NOT use for URL-valued attributes (href, src) — those require URL
 * encoding via `encodeURI` / the `URL` constructor on top of this.
 */
export function escapeHtml(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
