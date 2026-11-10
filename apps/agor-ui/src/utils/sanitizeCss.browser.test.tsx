// biome-ignore-all lint/plugin/noHardcodedColorLiteral: sanitizer tests assert on literal CSS input strings
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeBoardCss } from './sanitizeCss';

const SCOPE_CLASS = 'board-css-abc';
const MARKED = 'rgb(255, 0, 0)';

const mounted: HTMLStyleElement[] = [];

/** Apply sanitized board CSS to a live page with one element inside the canvas and one outside. */
function render(css: string) {
  const style = document.createElement('style');
  mounted.push(style);
  style.textContent = sanitizeBoardCss(css, `.${SCOPE_CLASS}`);
  const canvas = document.createElement('div');
  canvas.className = SCOPE_CLASS;
  const inside = document.createElement('p');
  inside.className = 'x';
  canvas.appendChild(inside);
  const outside = document.createElement('p');
  outside.className = 'x';
  document.head.appendChild(style);
  document.body.append(canvas, outside);
  return { inside, outside };
}

afterEach(() => {
  for (const style of mounted.splice(0)) style.remove();
  document.body.replaceChildren();
});

describe('sanitizeBoardCss in a real CSS parser', () => {
  it.each([
    '@x;.x{color:red}',
    '@media all;.x{color:red}',
    '@media/*{;.x{color:red}',
    '@media "{";.x{color:red}',
    '~ .x{color:red}',
    'a{} @x;.x{color:red}',
    '@media all{@x;.x{color:red}}',
    'a { color: blue; :not(&) { color: red } }',
    '.x { color: blue; :has(&) .x { color: red } }',
    '/\\*}*/ .x{color:red}',
    "/'*}*/ .x{color:red}",
    '//**/*}*/ .x{color:red}',
    ':is(*, }) .x{color:red}',
    ':is(body, }a) .x{color:red}',
  ])('styles nothing outside the board canvas: %s', (css) => {
    const { outside } = render(css);
    expect(getComputedStyle(outside).color).not.toBe(MARKED);
    expect(getComputedStyle(document.body).color).not.toBe(MARKED);
  });

  it.each([
    '.x { color: red }',
    '@media (min-width: 1px) { .x { color: red } }',
    '@layer base { .x { color: red } }',
    'color: red; animation: spin 2s infinite; @keyframes spin { to { opacity: 0.5 } }',
  ])('still styles the board canvas: %s', (css) => {
    const { inside, outside } = render(css);
    expect(getComputedStyle(inside).color).toBe(MARKED);
    expect(getComputedStyle(outside).color).not.toBe(MARKED);
  });
});
