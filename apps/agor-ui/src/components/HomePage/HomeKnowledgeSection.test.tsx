import type { AgorClient, KnowledgeNamespace } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { HomeKnowledgeSection, pickSpaces } from './HomeKnowledgeSection';

const space = (slug: string, kind: KnowledgeNamespace['kind'], updated: string) =>
  ({
    namespace_id: slug,
    slug,
    display_name: `Space ${slug}`,
    kind,
    updated_at: updated,
  }) as unknown as KnowledgeNamespace;

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{`${pathname}${search}`}</output>;
}

describe('HomeKnowledgeSection', () => {
  it('keeps shared spaces only, newest first, five at most', () => {
    const spaces = [
      space('old', 'global', '2026-01-01'),
      space('memory', 'branch', '2026-09-01'),
      space('mine', 'user', '2026-09-02'),
      ...['a', 'b', 'c', 'd', 'e'].map((s, i) => space(s, 'team', `2026-08-0${i + 1}`)),
    ];
    expect(pickSpaces(spaces).map((s) => s.slug)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('links to spaces and hands searches to the Knowledge page', async () => {
    const client = {
      service: () => ({ find: async () => [space('eng', 'team', '2026-09-01')] }),
    } as unknown as AgorClient;
    render(
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
        <HomeKnowledgeSection client={client} connected />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: /Space eng/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/eng');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), {
      target: { value: 'runbook' },
    });
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search knowledge' }), {
      key: 'Enter',
    });
    expect(screen.getByTestId('where')).toHaveTextContent('/knowledge?q=runbook');
  });

  it('offers a retry when spaces fail to load', async () => {
    const find = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <HomeKnowledgeSection
          client={{ service: () => ({ find }) } as unknown as AgorClient}
          connected
        />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(find).toHaveBeenCalledTimes(2);
  });
});
