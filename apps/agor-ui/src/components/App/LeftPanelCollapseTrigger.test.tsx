import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LeftPanelCollapseTrigger } from './LeftPanelCollapseTrigger';

describe('LeftPanelCollapseTrigger', () => {
  it('renders an accessible close button at the expanded panel/resize-handle edge', () => {
    render(
      <LeftPanelCollapseTrigger
        collapsed={false}
        panelSizePercent={24}
        collapsedPanelSizePercent={4}
        onToggle={vi.fn()}
      />
    );

    const button = screen.getByRole('button', { name: 'Close side panel' });

    expect(button).toBeInTheDocument();
    expect(button).toHaveStyle({ left: 'calc(24% + 2px)' });
  });

  it('toggles without requiring the resize handle itself to be clicked', () => {
    const onToggle = vi.fn();
    render(
      <LeftPanelCollapseTrigger
        collapsed={false}
        panelSizePercent={24}
        collapsedPanelSizePercent={4}
        onToggle={onToggle}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close side panel' }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('renders an accessible open button at the collapsed rail edge', () => {
    render(
      <LeftPanelCollapseTrigger
        collapsed
        panelSizePercent={24}
        collapsedPanelSizePercent={4}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Open side panel' })).toHaveStyle({
      left: 'calc(4% + 2px)',
    });
  });
});
