import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileHeader } from './MobileHeader';

describe('MobileHeader', () => {
  it('renders a plain title without search or comments actions', () => {
    render(<MobileHeader title="Sessions" />);
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a back control when onBack is set', () => {
    const onBack = vi.fn();
    render(<MobileHeader title="Session" onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });
});
