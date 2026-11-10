// biome-ignore-all lint/plugin/noHardcodedColorLiteral: sanitizer tests assert on literal CSS input strings
import { afterEach, describe, expect, it } from 'vitest';
import { ANIMATION_PRESETS, BACKGROUND_PRESETS } from '../components/forms/boardBackgroundPresets';
import { buildScopedBoardCss, sanitizeBoardCss } from './sanitizeCss';

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
    '@media print, screen { .x { color: red } }',
    '.x { color: red } @layer a, b;',
  ])('still styles the board canvas: %s', (css) => {
    const { inside, outside } = render(css);
    expect(getComputedStyle(inside).color).toBe(MARKED);
    expect(getComputedStyle(outside).color).not.toBe(MARKED);
  });

  it('keeps board @keyframes from replacing an app animation of the same name', () => {
    const appStyle = document.createElement('style');
    mounted.push(appStyle);
    appStyle.textContent =
      '@keyframes spin { from, to { color: rgb(0, 128, 0) } } .app { animation: spin 1s infinite paused }';
    document.head.appendChild(appStyle);
    const app = document.createElement('p');
    app.className = 'app';

    const { inside } = render(
      '@keyframes spin { from, to { color: red } } .x { animation: spin 1s infinite paused }'
    );
    document.body.append(app);

    expect(getComputedStyle(app).color).toBe('rgb(0, 128, 0)');
    expect(getComputedStyle(inside).color).toBe(MARKED);
  });

  it('runs board keyframes referenced from an animation that uses var()', () => {
    const { inside } = render(
      '@keyframes spin { from, to { color: red } } .x { --d: 1s; animation: spin var(--d) infinite paused }'
    );
    expect(getComputedStyle(inside).color).toBe(MARKED);
  });

  it.each(ANIMATION_PRESETS.map((preset) => [preset.label, preset.value]))(
    'runs the %s animation preset under its board-scoped keyframes',
    (_label, css) => {
      const style = document.createElement('style');
      mounted.push(style);
      style.textContent = buildScopedBoardCss({
        backgroundColor: BACKGROUND_PRESETS[0]?.value,
        customCss: css,
        scopeClass: SCOPE_CLASS,
      });
      document.head.appendChild(style);
      const canvas = document.createElement('div');
      canvas.className = SCOPE_CLASS;
      document.body.append(canvas);

      const name = getComputedStyle(canvas).animationName;
      expect(name.startsWith(`${SCOPE_CLASS}-`)).toBe(true);
      expect(
        canvas.getAnimations().map((animation) => (animation as CSSAnimation).animationName)
      ).toEqual([name]);
    }
  );
});
