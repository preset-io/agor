import { render, screen } from '@testing-library/react';
import type {} from '@vitest/browser-playwright';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { BranchPill } from './Pill';

// A file earlier in this worker may leave touch emulation on; pin a hover-capable pointer.
beforeEach(() =>
  cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'hover' }] })
);
afterEach(() => cdp().send('Emulation.setEmulatedMedia', { features: [] }));

const BRANCH = 'feature-fade-truncation-for-long-titles-on-desktop-and-mobile-surfaces';

it('fades a clipped compact label instead of cutting it mid-letter', async () => {
  render(
    <div style={{ width: 200 }}>
      <BranchPill branch={BRANCH} compact quiet maxWidth={120} />
    </div>
  );

  const label = screen.getByText(BRANCH);
  // CI runs two files per viewport page, so this frame can lay out late; wait for the clip.
  await expect.poll(() => label.dataset.overflowing, { timeout: 10_000 }).toBe('true');
  expect(getComputedStyle(label).maskImage).toContain('calc(100% - 12px)');
  expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(120);
});
