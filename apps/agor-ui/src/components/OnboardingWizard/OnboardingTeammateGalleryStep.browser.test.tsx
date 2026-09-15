import { act, cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { OnboardingWizard } from './OnboardingWizard';

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  await page.viewport(originalViewport.width, originalViewport.height);
});

// Intersect every clipping ancestor, not just the scroller's nominal box.
function visibleBox(element: Element) {
  const rect = element.getBoundingClientRect();
  let top = Math.max(0, rect.top);
  let bottom = Math.min(window.innerHeight, rect.bottom);
  for (
    let parent = element.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) {
      const clip = parent.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  return { top, bottom, height: Math.max(0, bottom - top) };
}

it.each([
  [320, 568],
  [844, 480],
  [844, 430],
])('keeps baseline gallery space and scrollable disclosure at %dx%d', async (width, height) => {
  await page.viewport(width, height);
  // Real components, null client: layout evidence only, not provisioning/executor evidence.
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <OnboardingWizard
        open
        initialStep="workspace"
        client={null}
        onComplete={vi.fn()}
        onUpdateUser={vi.fn(async () => undefined)}
      />
    </ConfigProvider>
  );
  await screen.findByLabelText('Teammate name');
  await act(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished)
    );
  });
  const grid = screen.getByRole('group', { name: 'Teammate template' });
  const scroller = grid.parentElement!;
  const disclosure = screen.getByText(/With the public starter, home files stay/);
  const actual = visibleBox(scroller);

  // The pre-disclosure baseline is this same layout with only the new copy hidden.
  disclosure.style.display = 'none';
  const baseline = visibleBox(scroller);
  disclosure.style.removeProperty('display');
  expect(actual.height).toBeGreaterThan(0);
  expect(actual.height).toBeCloseTo(baseline.height, 1);
  expect(actual.top).toBeCloseTo(baseline.top, 1);
  expect(disclosure.parentElement).toBe(scroller);
  expect(grid.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // All lines must be reachable inside the true clip, even where the pre-existing
  // short layout shows less than a full line at once. No 844x390 layout repair here.
  const range = document.createRange();
  range.selectNodeContents(disclosure);
  const lineCount = range.getClientRects().length;
  expect(lineCount).toBeGreaterThan(0);
  for (let index = 0; index < lineCount; index++) {
    const line = range.getClientRects()[index];
    const clip = visibleBox(scroller);
    await act(async () => {
      scroller.scrollTop += (line.top + line.bottom - clip.top - clip.bottom) / 2;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const reached = range.getClientRects()[index];
    const visible = visibleBox(scroller);
    expect(
      Math.min(reached.bottom, visible.bottom) - Math.max(reached.top, visible.top)
    ).toBeGreaterThan(0);
    const hit = document.elementFromPoint(
      (reached.left + reached.right) / 2,
      (Math.max(reached.top, visible.top) + Math.min(reached.bottom, visible.bottom)) / 2
    );
    expect(hit === disclosure || disclosure.contains(hit)).toBe(true);
  }
  console.info('local-home disclosure geometry', { width, height, actual, baseline, lineCount });
});
