import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from './MobileTabBar';

describe('MobileTabBar', () => {
  it('reports the tapped destination', () => {
    const onSelect = vi.fn();
    render(<MobileTabBar activeTab="board" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(onSelect).toHaveBeenCalledWith('home');

    fireEvent.click(screen.getByRole('button', { name: 'Ask your primary assistant' }));
    expect(onSelect).toHaveBeenCalledWith('ask');
  });

  it('marks the active tab for assistive tech (not colour alone)', () => {
    render(<MobileTabBar activeTab="marketplace" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Marketplace' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('button', { name: 'Board' })).not.toHaveAttribute('aria-current');
  });

  it('is icon-only: destination names exist as aria-labels, not visible text', () => {
    render(<MobileTabBar activeTab="marketplace" onSelect={vi.fn()} />);
    // The active tab is indicated by the highlight + colour, never a text label,
    // so even the active destination renders no visible label text.
    for (const name of ['Home', 'Board', 'Marketplace', 'More']) {
      expect(screen.queryByText(name)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('renders the center Ask as a flat compose button (no emoji)', () => {
    render(<MobileTabBar activeTab={null} onSelect={vi.fn()} />);
    const ask = screen.getByRole('button', { name: 'Ask your primary assistant' });
    // Variant B: a clean compose icon, not an emoji, and flush (no lift shadow).
    expect(ask.querySelector('.anticon-edit')).toBeTruthy();
    expect(ask).toHaveTextContent('');
  });
});
