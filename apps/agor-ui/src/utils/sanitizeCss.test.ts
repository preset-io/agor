// biome-ignore-all lint/plugin/noHardcodedColorLiteral: sanitizer tests assert on literal CSS input/output strings
import { describe, expect, it } from 'vitest';
import { buildScopedBoardCss, sanitizeBoardCss, validateBoardCss } from './sanitizeCss';

const SCOPE = '.board-css-abc';

describe('sanitizeBoardCss', () => {
  it('wraps raw declarations in the scope selector', () => {
    const out = sanitizeBoardCss('background: red; color: blue;', SCOPE);
    expect(out).toContain(`${SCOPE} {`);
    expect(out).toContain('background: red;');
  });

  it('scopes EVERY selector in a comma-separated list (no global escape)', () => {
    const out = sanitizeBoardCss('.foo, body, html, * { color: red }', SCOPE);
    // Each selector is individually prefixed …
    expect(out).toContain(`${SCOPE} .foo`);
    expect(out).toContain(`${SCOPE} body`);
    expect(out).toContain(`${SCOPE} html`);
    expect(out).toContain(`${SCOPE} *`);
    // … and no selector escapes the scope to hit the whole document.
    expect(out).not.toMatch(/(^|[,{]\s*)(body|html|\*)\s*\{/m);
  });

  it('leaves @media preludes intact while scoping their inner selectors', () => {
    const out = sanitizeBoardCss('@media (max-width: 600px) { body { color: red } }', SCOPE);
    expect(out).toContain('@media (max-width: 600px)');
    expect(out).not.toContain(`${SCOPE} @media`);
    expect(out).toContain(`${SCOPE} body`);
  });

  it('strips `<` so it cannot terminate the host <style> element', () => {
    const out = sanitizeBoardCss('color: red; } </style><script>alert(1)</script>', SCOPE);
    expect(out).not.toContain('<');
  });

  it('blocks url(), @import, expression(), and javascript:', () => {
    const out = sanitizeBoardCss(
      'background: url(http://evil/x); @import "http://evil"; width: expression(alert(1)); color: javascript:x;',
      SCOPE
    );
    expect(out).not.toMatch(/url\s*\(/i);
    expect(out).not.toMatch(/@import/i);
    expect(out).not.toMatch(/expression\s*\(/i);
    expect(out).not.toMatch(/javascript\s*:/i);
  });

  it('blocks tokens hidden behind CSS comments', () => {
    // The browser treats the comment as a separator; our de-obfuscation strips
    // it before matching so the blocklist still catches the reassembled token.
    const out = sanitizeBoardCss('background: url/**/(http://evil/x);', SCOPE);
    // No live url() token survives (the leftover URL text is inert, not fetched).
    expect(out).not.toMatch(/url\s*\(/i);
  });

  it('blocks tokens hidden behind CSS escapes', () => {
    // "\75 rl(" is the CSS escape for "url(". Stripping backslashes prevents
    // the parser from reassembling it into a live url() token (the leftover
    // "rl(" is inert — the browser loads nothing from it).
    const out = sanitizeBoardCss('background: \\75 rl(http://evil/x);', SCOPE);
    expect(out).not.toMatch(/url\s*\(/i);
    expect(out).not.toContain('\\');
  });

  it('reports comment-obfuscated blocked tokens via validateBoardCss', () => {
    expect(validateBoardCss('background: @imp/**/ort url(x)').length).toBeGreaterThan(0);
  });

  it('does not throw on malformed braces', () => {
    expect(() => sanitizeBoardCss('color: red } .evil { color: blue', SCOPE)).not.toThrow();
    expect(typeof sanitizeBoardCss('} } {{', SCOPE)).toBe('string');
  });

  it.each([
    ['an unknown at-rule statement', '@x;body{color:red}'],
    ['a grouping at-rule ended by a semicolon', '@media all;body{color:red}'],
    ['an unterminated comment', '@media/*{;body{color:red}'],
    ['a string holding braces', '@media "{";body{color:red}'],
  ])('does not let %s escape the scope', (_label, css) => {
    expect(sanitizeBoardCss(css, SCOPE)).not.toMatch(/(^|[;}]\s*)body/m);
  });

  it('drops selectors that start with a sibling combinator or refer to their parent', () => {
    expect(sanitizeBoardCss('~ *, + div { color: red }', SCOPE)).not.toMatch(/[~+]/);
    expect(sanitizeBoardCss('a { color: blue; :not(&) { color: red } }', SCOPE)).not.toMatch(/&/);
  });

  it('blocks image-set(), which loads images from plain strings', () => {
    const out = sanitizeBoardCss(
      'background: -webkit-image-set("https://x.test/a.png" 1x);',
      SCOPE
    );
    expect(out).not.toMatch(/image-set\s*\(/i);
  });

  it('keeps quoted values that carry no structure', () => {
    expect(sanitizeBoardCss('.x::after { content: "★" }', SCOPE)).toContain('content: "★"');
  });

  it('keeps @keyframes at top level, named under the board scope', () => {
    const out = sanitizeBoardCss(
      '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }',
      SCOPE
    );
    expect(out).toContain('@keyframes board-css-abc-spin');
    expect(out).not.toContain(`${SCOPE} @keyframes`);
  });

  it('keeps every query of a grouping at-rule list', () => {
    expect(sanitizeBoardCss('@media screen, print { .x { color: red } }', SCOPE)).toContain(
      '@media screen, print'
    );
  });

  it('accepts a trailing @layer statement', () => {
    expect(sanitizeBoardCss('.x { color: red } @layer a, b;', SCOPE)).toContain('@layer a, b;');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeBoardCss('', SCOPE)).toBe('');
    expect(sanitizeBoardCss(undefined, SCOPE)).toBe('');
  });
});

describe('buildScopedBoardCss', () => {
  it('returns empty when the board carries no styling', () => {
    expect(buildScopedBoardCss({ scopeClass: 'board-x' })).toBe('');
    expect(
      buildScopedBoardCss({ backgroundColor: '   ', customCss: '', scopeClass: 'board-x' })
    ).toBe('');
  });

  it('prepends the background as a scoped declaration', () => {
    const out = buildScopedBoardCss({
      backgroundColor: 'linear-gradient(180deg, #000, #111)',
      scopeClass: 'board-x',
    });
    expect(out).toContain('.board-x {');
    expect(out).toMatch(/background: linear-gradient\(180deg, (#000|rgb\(0, 0, 0\)),/);
  });

  it('appends a reduced-motion override covering the root AND descendants', () => {
    const out = buildScopedBoardCss({
      backgroundColor: '#123456',
      customCss: 'animation: spin 2s infinite;',
      scopeClass: 'board-x',
    });
    expect(out).toContain('@media (prefers-reduced-motion: reduce)');
    expect(out).toContain('.board-x, .board-x * { animation: none !important; }');
  });

  it('routes background_color through the sanitizer too', () => {
    const out = buildScopedBoardCss({
      backgroundColor: 'url(http://evil/x)',
      scopeClass: 'board-x',
    });
    expect(out).not.toMatch(/url\s*\(/i);
  });
});

describe('validateBoardCss', () => {
  it('reports blocked patterns', () => {
    expect(validateBoardCss('background: url(x)')).toHaveLength(1);
    expect(validateBoardCss('color: red')).toHaveLength(0);
  });
});
