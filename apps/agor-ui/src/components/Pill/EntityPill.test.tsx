import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BoardPill } from './Pill';

it('keeps the full board name for the clipped-label tooltip, not a native title', () => {
  render(<BoardPill board={{ name: 'Product design and marketing launch' }} compact quiet />);

  const label = screen.getByText('Product design and marketing launch');
  expect(label).toHaveAttribute('data-fade-text');
  expect(label.closest('[title]')).toBeNull();
});
