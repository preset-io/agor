import { fireEvent, render, screen } from '@testing-library/react';
import { Button } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ActionLinkRow } from './ActionLinkRow';

describe('ActionLinkRow', () => {
  it('keeps actions independent and preserves native link targets', () => {
    const onActivate = vi.fn();
    const onSecondary = vi.fn();

    render(
      <MemoryRouter>
        <ActionLinkRow
          ariaLabel="Open example"
          onActivate={onActivate}
          actions={
            <Button aria-label="Secondary action" onClick={onSecondary}>
              Secondary
            </Button>
          }
        >
          Example action
        </ActionLinkRow>
        <ActionLinkRow
          ariaLabel="Open external docs"
          href="https://example.com/docs"
          navigation="external"
        >
          External docs
        </ActionLinkRow>
        <ActionLinkRow ariaLabel="Open knowledge" href="/kb/team/guide" navigation="spa">
          Knowledge guide
        </ActionLinkRow>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Secondary action' }));
    expect(onSecondary).toHaveBeenCalledOnce();
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open example' }));
    expect(onActivate).toHaveBeenCalledOnce();

    expect(screen.getByRole('link', { name: 'Open external docs' })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    );
    const spaLink = screen.getByRole('link', { name: 'Open knowledge' });
    expect(spaLink).toHaveAttribute('href', '/kb/team/guide');
  });
});
