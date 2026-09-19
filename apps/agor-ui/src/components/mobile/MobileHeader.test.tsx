import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileHeader } from './MobileHeader';

describe('MobileHeader', () => {
  it('opens a board switch sheet from the title chevron and reports the choice', () => {
    const onSelect = vi.fn();
    render(
      <MobileHeader
        title="Design board"
        boardSwitcher={{
          boards: [
            { board_id: 'b1', name: 'Design board' },
            { board_id: 'b2', name: 'Infra board' },
          ],
          currentBoardId: 'b1',
          onSelect,
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Switch board/ }));
    fireEvent.click(screen.getByText('Infra board'));
    expect(onSelect).toHaveBeenCalledWith('b2');
  });

  it('renders a plain title with no switcher when none is provided', () => {
    render(<MobileHeader title="Sessions" />);
    expect(screen.queryByRole('button', { name: /Switch board/ })).not.toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
  });

  it('shows a back control when onBack is set', () => {
    const onBack = vi.fn();
    render(<MobileHeader title="Session" onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });
});
