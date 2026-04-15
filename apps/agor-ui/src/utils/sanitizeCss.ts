/**
 * CSS sanitizer for board custom CSS.
 *
 * Allows safe CSS properties and @keyframes while blocking XSS vectors.
 * Returns sanitized CSS scoped to a board-specific class selector.
 */

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
 * Sanitize and scope custom CSS for a board canvas.
 *
 * - Strips dangerous CSS patterns (url(), expression(), @import, etc.)
 * - Separates @keyframes blocks from property declarations
 * - Scopes property declarations to the board's canvas element
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
      // User wrote CSS rules with selectors — scope each rule
      parts.push(
        `${scopeSelector} { }\n${declarations.replace(/([^{}]+)\{/g, `${scopeSelector} $1{`)}`
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
