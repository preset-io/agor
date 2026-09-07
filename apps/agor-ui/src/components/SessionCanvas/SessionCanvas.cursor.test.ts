import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const appCss = fs.readFileSync('src/index.css', 'utf8');
const canvasCss = fs.readFileSync('src/components/SessionCanvas/SessionCanvas.css', 'utf8');
let styleElement: HTMLStyleElement;

describe('React Flow no-drag cursor boundary', () => {
  beforeEach(() => {
    styleElement = document.createElement('style');
    // Match the production cascade: app semantics first, canvas overrides second.
    styleElement.textContent = `${appCss}\n${canvasCss}`;
    document.head.append(styleElement);
  });

  afterEach(() => styleElement.remove());

  it('preserves interactive cursors and text selection inside a no-drag region', () => {
    const region = document.createElement('div');
    region.className = 'nodrag';
    region.innerHTML = `
      <a data-streamdown="link" href="https://example.test">Markdown link</a>
      <button style="cursor: pointer">Action</button>
      <span>Selectable text</span>
    `;
    document.body.append(region);

    expect(getComputedStyle(region).cursor).toBe('auto');
    expect(getComputedStyle(region).userSelect).toBe('text');
    expect(getComputedStyle(region.querySelector('a') as HTMLAnchorElement).cursor).toBe('pointer');
    expect(getComputedStyle(region.querySelector('button') as HTMLButtonElement).cursor).toBe(
      'pointer'
    );

    region.remove();
  });
});

describe('arrange motion CSS', () => {
  it('settles monotonically and never eases a node being dragged', () => {
    expect(canvasCss).toMatch(
      /\.react-flow\.agor-dealing \.react-flow__node \{[\s\S]*?transform[^;]*cubic-bezier\(0\.22, 1, 0\.36, 1\)/
    );
    expect(canvasCss).toMatch(
      /\.react-flow\.agor-dealing \.react-flow__node\.dragging \{\s*transition: none;/
    );
  });
});
