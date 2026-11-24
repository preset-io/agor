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
  /image-set\s*\(/gi, // Loads images from plain strings (also matches -webkit-image-set)
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
 * Neutralize obfuscation the browser's CSS parser would silently normalize
 * away, so the lexical blocklist below can't be evaded by hiding a blocked
 * token behind comments or escapes:
 *
 *   - `url/*x*​/(…)`      → comment acts as a separator to the parser
 *   - `\75 rl(…)`         → CSS escape for `u`, reassembled by the parser
 *
 * Board backgrounds never legitimately need CSS comments or backslash escapes,
 * so stripping both is safe and makes the subsequent pattern checks robust.
 */
function deobfuscateCss(css: string): string {
  return (
    css
      .replace(/\/\*[\s\S]*?(\*\/|$)/g, '') // strip CSS comments, including an unterminated one
      .replace(/\\/g, '') // strip CSS escape backslashes
      // Braces/semicolons inside strings would desync the brace-based scoping from the parser.
      .replace(/"[^"\n]*"|'[^'\n]*'|["']/g, (token) =>
        token.length > 1 ? token.replace(/[{};]/g, '') : ''
      )
  );
}

/** Grouping at-rules whose prelude may pass through unscoped; their inner rules are scoped. */
const GROUPING_AT_RULE_PRELUDE = /^@(media|supports|container|layer|starting-style)\b[^;&]*$/i;

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
  // Grouping at-rule prelude (a whole query list) — keep as-is; its inner rules get scoped separately.
  if (GROUPING_AT_RULE_PRELUDE.test(selectorList.trim())) return selectorList.trim();
  return selectorList
    .split(',')
    .map((raw) => {
      const selector = raw.trim();
      if (!selector) return '';
      // Only plain selectors are scoped: `;`/`@` can end the prefix early, `&` and `~`/`+` can match outside it.
      if (/[;@&]/.test(selector) || /^[~+]/.test(selector)) return '';
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

  // Normalize away comment/escape obfuscation FIRST so blocked tokens can't be
  // hidden from the pattern checks below.
  let sanitized = deobfuscateCss(css);
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

  // The text pass above is lexical; the browser's parser decides what actually applies.
  return serializeScopedRules(parts.join('\n\n'), scopeSelector);
}

/** Grouping rules whose children are checked like top-level rules. */
const GROUPING_RULE_TYPES = new Set([
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSContainerRule',
  'CSSLayerBlockRule',
  'CSSStartingStyleRule',
]);

/** Split a serialized selector list at top-level commas. */
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(selectorText.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selectorText.slice(start).trim());
  return parts;
}

/**
 * Parse `css` with the browser and return its serialized rules, or '' unless every rule
 * stays inside `scopeSelector`: style rules are scoped descendants (nested ones relative
 * to their parent), grouping rules hold only such rules, @keyframes and @layer statements
 * are allowed, and nothing loads resources. The board's own @keyframes are renamed under
 * the scope so they cannot replace app animations of the same name.
 */
function serializeScopedRules(css: string, scopeSelector: string): string {
  if (!css || typeof document === 'undefined') return '';
  const escapedScope = scopeSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scoped = new RegExp(`^${escapedScope}(\\s+[^\\s~+]|$)`);
  const nested = /^(&\s+)?[^\s~+&]/;
  const keyframes: CSSKeyframesRule[] = [];
  const declarations: CSSStyleDeclaration[] = [];
  const checkRules = (list: CSSRuleList, insideStyleRule: boolean): boolean =>
    Array.from(list).every((rule) => {
      if (containsDangerousPattern(rule.cssText)) return false;
      const type = rule.constructor.name;
      if (type === 'CSSStyleRule') {
        const { selectorText, cssRules, style } = rule as CSSStyleRule;
        declarations.push(style);
        const ok = splitSelectorList(selectorText).every((selector) =>
          insideStyleRule
            ? nested.test(selector) && !selector.slice(1).includes('&')
            : scoped.test(selector) && !selector.includes('&')
        );
        return ok && (!cssRules || checkRules(cssRules, true));
      }
      if (type === 'CSSKeyframesRule') {
        keyframes.push(rule as CSSKeyframesRule);
        return !insideStyleRule;
      }
      if (type === 'CSSNestedDeclarations') {
        declarations.push((rule as CSSStyleRule).style);
        return insideStyleRule;
      }
      if (type === 'CSSLayerStatementRule') return !insideStyleRule;
      if (GROUPING_RULE_TYPES.has(type)) {
        return checkRules((rule as CSSGroupingRule).cssRules, insideStyleRule);
      }
      return false;
    });

  // `not all` lets the browser parse the sheet without ever applying it.
  const style = document.createElement('style');
  style.media = 'not all';
  style.textContent = css;
  document.head.appendChild(style);
  try {
    const rules = style.sheet?.cssRules;
    if (!rules || !checkRules(rules, false)) return '';
    renameBoardKeyframes(keyframes, declarations, scopeSelector.replace(/^\./, ''));
    return Array.from(rules, (rule) => rule.cssText).join('\n');
  } finally {
    style.remove();
  }
}

/** Prefix the board's own keyframe names and the animation-name references to them. */
function renameBoardKeyframes(
  keyframes: CSSKeyframesRule[],
  declarations: CSSStyleDeclaration[],
  prefix: string
): void {
  const renamed = new Map(keyframes.map((rule) => [rule.name, `${prefix}-${rule.name}`]));
  if (renamed.size === 0) return;
  for (const rule of keyframes) rule.name = renamed.get(rule.name) ?? rule.name;
  for (const style of declarations) {
    const names = style.getPropertyValue('animation-name');
    if (names && !names.includes('var(')) {
      const next = names
        .split(',')
        .map((name) => renamed.get(name.trim().replace(/^["']|["']$/g, '')) ?? name.trim())
        .join(', ');
      style.setProperty('animation-name', next, style.getPropertyPriority('animation-name'));
      continue;
    }
    // A value with var() stays unresolved until computed, so rename its matching idents in place.
    for (const property of ['animation', 'animation-name']) {
      const value = style.getPropertyValue(property);
      if (!value.includes('var(')) continue;
      const next = value.replace(/(^|[\s,(])([A-Za-z_][\w-]*)(?=$|[\s,)])/g, (match, lead, name) =>
        renamed.has(name) ? `${lead}${renamed.get(name)}` : match
      );
      style.setProperty(property, next, style.getPropertyPriority(property));
    }
  }
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

  // Scan the de-obfuscated form so comment/escape-hidden tokens are still
  // reported (matching what sanitizeBoardCss will strip).
  const scanned = deobfuscateCss(css);
  const issues: string[] = [];

  for (const pattern of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(scanned)) {
      const name = pattern.source.replace(/\\s\*\\\(/g, '()').replace(/\\s\*:/g, ':');
      issues.push(`Blocked pattern: ${name}`);
    }
  }

  return issues;
}
