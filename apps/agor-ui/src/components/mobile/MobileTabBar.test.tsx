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
    render(<MobileTabBar activeTab="comments" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Comments' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('button', { name: 'Board' })).not.toHaveAttribute('aria-current');
  });

  it('shows the primary assistant emoji when provided', () => {
    render(<MobileTabBar activeTab={null} onSelect={vi.fn()} askEmoji="🦊" />);
    expect(screen.getByRole('button', { name: 'Ask your primary assistant' })).toHaveTextContent(
      '🦊'
    );
  });
});
