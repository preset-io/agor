/**
 * CSS sanitizer for board custom CSS.
 *
 * Allows safe CSS properties and @keyframes while blocking XSS vectors.
 * Returns sanitized CSS scoped to a board-specific class selector.
 *
 * Trust boundary: board CSS is authored by users who can edit the board and is
 * rendered for everyone viewing it, so the sanitizer must both strip active
 * content (url()/expression()/@import/etc.) AND keep the CSS confined to the
 * board canvas so it cannot restyle the surrounding app.
 */

import { hasBoardStyling } from './boardBackground';

/** Patterns that are dangerous in CSS and must be stripped */
const DANGEROUS_PATTERNS = [
  /url\s*\(/gi, // External resource loading, data exfiltration
  /expression\s*\(/gi, // IE CSS expressions (JS execution)
  /javascript\s*:/gi, // JS protocol
  /behavior\s*:/gi, // IE .htc behaviors
  /-moz-binding\s*:/gi, // Firefox XBL bindings
  /@import/gi, // External stylesheet loading
  /@charset/gi, // Encoding attacks
  /@font-face/gi, // External font loading
  /@namespace/gi, // Namespace injection
  /\\00/gi, // Null byte escapes
];

/**
 * Check if a CSS string contains dangerous patterns.
 */
function containsDangerousPattern(css: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    if (pattern.test(css)) {
      return pattern.source;
    }
  }
  return null;
}

/**
 * Scope a (possibly comma-separated) selector list to the board canvas.
 *
 * Every selector in the list is prefixed — `.foo, body` becomes
 * `.scope .foo, .scope body` — so a selector list cannot smuggle an unscoped
 * selector (e.g. `body`, `html`, `*`) that would escape into the whole app.
 * At-rule preludes (e.g. `@media (...)`) are left intact; the selectors nested
 * inside their block are scoped by the same pass.
 */
function scopeSelectorList(selectorList: string, scopeSelector: string): string {
  return selectorList
    .split(',')
    .map((raw) => {
      const selector = raw.trim();
      if (!selector) return '';
      // At-rule prelude — keep as-is; its inner rules get scoped separately.
      if (selector.startsWith('@')) return selector;
      return `${scopeSelector} ${selector}`;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * Sanitize and scope custom CSS for a board canvas.
 *
 * - Strips dangerous CSS patterns (url(), expression(), @import, etc.)
 * - Strips `<` so custom CSS can never break out of the host `<style>` element
 * - Separates @keyframes blocks from property declarations
 * - Scopes every selector (including each entry in a selector list) to the
 *   board's canvas element
 * - Returns empty string if input is empty or entirely dangerous
 *
 * @param css - Raw CSS input from the user
 * @param scopeSelector - CSS selector to scope declarations to (e.g. ".board-css-abc123")
 * @returns Sanitized and scoped CSS string, or empty string
 */
export function sanitizeBoardCss(css: string | undefined, scopeSelector: string): string {
  if (!css?.trim()) return '';

  // Check for dangerous patterns and strip them
  let sanitized = css;
  for (const pattern of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '/* blocked */');
  }

  // Strip `<` entirely. It is never valid in the CSS we accept, and removing it
  // makes it impossible to terminate the host <style> element (e.g. "</style>")
  // regardless of which injection sink renders the result.
  sanitized = sanitized.replace(/</g, '');

  // Extract @keyframes blocks (they must remain at top level, not scoped)
  const keyframesBlocks: string[] = [];
  const withoutKeyframes = sanitized.replace(
    /@keyframes\s+[\w-]+\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi,
    (match) => {
      // Validate the keyframes block itself doesn't contain dangerous patterns
      const danger = containsDangerousPattern(match);
      if (!danger) {
        keyframesBlocks.push(match);
      }
      return '';
    }
  );

  // Everything remaining is treated as property declarations to be scoped
  const declarations = withoutKeyframes.trim();

  const parts: string[] = [];

  // Scope property declarations to the board canvas
  if (declarations) {
    // If the user wrote raw declarations (no selector), wrap them
    // If they wrote selectors, we still scope them under the board selector
    const hasSelector = /[^{}]+\{/.test(declarations);
    if (hasSelector) {
      // User wrote CSS rules with selectors — scope each selector in each rule.
      parts.push(
        `${scopeSelector} { }\n${declarations.replace(
          /([^{}]+)\{/g,
          (_match, selectorList: string) => `${scopeSelectorList(selectorList, scopeSelector)} {`
        )}`
      );
    } else {
      // Raw property declarations — wrap in scoped selector
      parts.push(`${scopeSelector} {\n${declarations}\n}`);
    }
  }

  // Append @keyframes blocks (global, not scoped)
  for (const kf of keyframesBlocks) {
    parts.push(kf);
  }

  return parts.join('\n\n');
}

/**
 * Compose the full scoped `<style>` payload for a board background.
 *
 * This is the single rendering pipeline shared by the canvas and the editor
 * preview so they cannot drift: it prepends `background_color` as a declaration
 * (so it goes through the same sanitizer as `custom_css`), scopes everything to
 * `scopeClass`, and appends a reduced-motion override that neutralizes any
 * animation on the board root AND its scoped descendants.
 *
 * Returns an empty string when the board carries no explicit styling, in which
 * case callers should fall back to the trusted inline themed default.
 */
export function buildScopedBoardCss(params: {
  backgroundColor?: string | null;
  customCss?: string | null;
  scopeClass: string;
}): string {
  const { backgroundColor, customCss, scopeClass } = params;
  if (!scopeClass || !hasBoardStyling(backgroundColor, customCss)) return '';

  const bgRule = backgroundColor?.trim() ? `background: ${backgroundColor};\n` : '';
  const scoped = sanitizeBoardCss(bgRule + (customCss || ''), `.${scopeClass}`);
  if (!scoped) return '';

  return `${scoped}\n\n@media (prefers-reduced-motion: reduce) {\n  .${scopeClass}, .${scopeClass} * { animation: none !important; }\n}`;
}

/**
 * Validate CSS input and return a list of issues found.
 * Used for UI warnings before saving.
 */
export function validateBoardCss(css: string | undefined): string[] {
  if (!css?.trim()) return [];

  const issues: string[] = [];

  for (const pattern of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(css)) {
      const name = pattern.source.replace(/\\s\*\\\(/g, '()').replace(/\\s\*:/g, ':');
      issues.push(`Blocked pattern: ${name}`);
    }
  }

  return issues;
}
