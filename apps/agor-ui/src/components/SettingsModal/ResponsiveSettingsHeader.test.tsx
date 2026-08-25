import { render, screen } from '@testing-library/react';
import { Grid, Input } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';

describe('ResponsiveSettingsHeader', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives compact actions the full available width', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: false });
    render(
      <ResponsiveSettingsHeader
        description="Manage integrations"
        actions={(compact) => (
          <Input aria-label="Search" style={{ width: compact ? '100%' : 360 }} />
        )}
      />
    );

    expect(screen.getByText('Manage integrations').parentElement).toHaveStyle({
      flexDirection: 'column',
    });
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveStyle({ width: '100%' });
  });

  it('retains bounded desktop controls', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(
      <ResponsiveSettingsHeader
        description="Manage integrations"
        actions={(compact) => (
          <Input aria-label="Search" style={{ width: compact ? '100%' : 360 }} />
        )}
      />
    );

    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveStyle({ width: '360px' });
  });
});
