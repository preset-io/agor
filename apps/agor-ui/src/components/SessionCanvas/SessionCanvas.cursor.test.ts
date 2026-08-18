import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync('src/components/SessionCanvas/SessionCanvas.css', 'utf8');

describe('React Flow no-drag cursor boundary', () => {
  it('resets the drag cursor only on the boundary, not interactive descendants', () => {
    expect(css).toMatch(/\.nodrag\s*{[^}]*cursor:\s*auto;/s);
    expect(css).toMatch(/\.nodrag\s*{[^}]*user-select:\s*text;/s);
    expect(css).not.toMatch(/\.nodrag\s*\*/);
  });
});
