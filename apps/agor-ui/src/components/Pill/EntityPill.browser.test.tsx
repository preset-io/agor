import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TOUCH_INPUT_QUERY } from '../../hooks/useCanHover';
import { BranchPill } from './Pill';

// Touch emulation is page-wide and other files toggle it in parallel, so this frame pins its
// own pointer: the phone project (320px) stands in for touch, the others can hover.
const touch = window.innerWidth <= 320;
const realMatchMedia = window.matchMedia.bind(window);
beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    realMatchMedia(query === TOUCH_INPUT_QUERY ? (touch ? 'all' : 'not all') : query)
  );
});
afterEach(() => vi.restoreAllMocks());

const BRANCH = 'feature-fade-truncation-for-long-titles-on-desktop-and-mobile-surfaces';

it('fades a clipped compact label on hover screens and keeps the ellipsis on touch', async () => {
  render(
    <div style={{ width: 200 }}>
      <BranchPill branch={BRANCH} compact quiet maxWidth={120} />
    </div>
  );

  const label = screen.getByText(BRANCH);
  expect(label).toHaveAttribute('data-fade-text');
  await expect.poll(() => label.dataset.overflowing).toBe('true');
  if (touch) {
    expect(getComputedStyle(label).maskImage).toBe('none');
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
  } else {
    expect(getComputedStyle(label).maskImage).toContain('calc(100% - 12px)');
  }
  expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(120);
});
