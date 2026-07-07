import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantPanelRail } from './AssistantPanelRail';

describe('AssistantPanelRail', () => {
  it('renders one button per tab, fully visible (no clipped floating knob)', () => {
    render(<AssistantPanelRail onSelectTab={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comments' })).toBeInTheDocument();
  });

  it('opens the Assistant tab when its button is clicked', () => {
    const onSelectTab = vi.fn();
    render(<AssistantPanelRail onSelectTab={onSelectTab} />);

    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));

    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith('assistant');
  });

  it('opens the All sessions tab when its button is clicked', () => {
    const onSelectTab = vi.fn();
    render(<AssistantPanelRail onSelectTab={onSelectTab} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));

    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith('all-sessions');
  });

  it('opens the Comments tab when its button is clicked', () => {
    const onSelectTab = vi.fn();
    render(<AssistantPanelRail onSelectTab={onSelectTab} />);

    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));

    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith('comments');
  });

  it('shows no unread badge on Comments when the count is zero', () => {
    render(<AssistantPanelRail onSelectTab={vi.fn()} unreadCommentsCount={0} />);

    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows the unread badge on Comments when there are unread comments', () => {
    render(<AssistantPanelRail onSelectTab={vi.fn()} unreadCommentsCount={3} />);

    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
