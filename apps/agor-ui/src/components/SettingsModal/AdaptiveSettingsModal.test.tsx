import { render, screen } from '@testing-library/react';
import { Grid } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';

describe('AdaptiveSettingsModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders phone dialogs as bottom sheets', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: false });
    render(
      <AdaptiveSettingsModal title="Create board" open onCancel={vi.fn()}>
        Board form
      </AdaptiveSettingsModal>
    );

    expect(screen.getByRole('dialog', { name: 'Create board' })).toHaveClass('ant-drawer-section');
    expect(screen.getByText('Board form')).toBeInTheDocument();
  });

  it('retains a modal at desktop widths', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(
      <AdaptiveSettingsModal title="Create board" open onCancel={vi.fn()}>
        Board form
      </AdaptiveSettingsModal>
    );

    expect(screen.getByRole('dialog', { name: 'Create board' })).toHaveClass('ant-modal');
  });
});
