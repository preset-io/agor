import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BranchPill } from './Pill';

it('fades a clipped compact label instead of cutting it mid-letter', async () => {
  render(
    <BranchPill branch="feature-fade-truncation-for-long-titles" compact quiet maxWidth={120} />
  );

  const label = screen.getByText('feature-fade-truncation-for-long-titles');
  await expect.poll(() => getComputedStyle(label).maskImage).toContain('calc(100% - 12px)');
  expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(120);
});
