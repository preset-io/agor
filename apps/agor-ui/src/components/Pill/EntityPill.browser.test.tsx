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

it('fades a clipped compact label instead of cutting it mid-letter', async () => {
  render(
    <BranchPill branch="feature-fade-truncation-for-long-titles" compact quiet maxWidth={120} />
  );

  const label = screen.getByText('feature-fade-truncation-for-long-titles');
  await expect.poll(() => getComputedStyle(label).maskImage).toContain('calc(100% - 12px)');
  expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(120);
});
