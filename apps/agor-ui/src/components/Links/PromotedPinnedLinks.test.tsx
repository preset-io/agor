import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromotedPinnedLinks } from './PromotedPinnedLinks';

const item = {
  key: 'runbook',
  name: 'Runbook',
  targetKey: 'url:https://example.com/runbook',
  category: 'url' as const,
  ownerScope: 'branch' as const,
  isPinned: true,
  href: 'https://example.com/runbook',
  navigation: 'external' as const,
};

afterEach(() => vi.restoreAllMocks());

describe('PromotedPinnedLinks', () => {
  it('opens pinned external links through the shared action resolver', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <MemoryRouter>
        <PromotedPinnedLinks items={[item]} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open pinned Runbook' }));
    expect(open).toHaveBeenCalledWith(
      'https://example.com/runbook',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
