import { render } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from './MobileTabBar';

// The bottom nav must never be wider than the shell: a non-shrinking pill row
// widens the document and clips content + nav at the same right edge.
function overflowers(root: HTMLElement, limit: number): string[] {
  const bad: string[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (el.getBoundingClientRect().right > limit + 1) {
      bad.push(
        `${el.tagName.toLowerCase()}.${(el.className?.toString() || '').slice(0, 24)} right=${el.getBoundingClientRect().right.toFixed(1)}`
      );
    }
  }
  return bad;
}

describe('MobileTabBar fits narrow viewports', () => {
  for (const width of [320, 360, 390, 430]) {
    it(`all 5 destinations + FAB fit at ${width}px (active=comments, badges shown)`, () => {
      const { container } = render(
        <ConfigProvider theme={{ token: { motion: false } }}>
          <div style={{ width, boxSizing: 'border-box' }} data-testid="vp">
            <MobileTabBar
              activeTab="marketplace"
              onSelect={vi.fn()}
              askEmoji="🤖"
              sessionsBadge={12}
            />
          </div>
        </ConfigProvider>
      );
      const vp = container.querySelector<HTMLElement>('[data-testid="vp"]')!;
      const limit = vp.getBoundingClientRect().right;
      for (const name of ['Home', 'Board', 'Marketplace', 'More', 'Ask your primary assistant']) {
        expect(vp.querySelector(`[aria-label="${name}"]`), `${name} missing`).toBeTruthy();
      }
      const bad = overflowers(vp, limit);
      expect(bad, `nav overflow at ${width}px:\n${bad.join('\n')}`).toEqual([]);
    });
  }
});
