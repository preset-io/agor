import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { HOME_KNOWLEDGE_LIMIT, HomeKnowledgeSection } from './HomeKnowledgeSection';

const doc = (id: string) => ({
  document_id: id,
  namespace_id: 'ns-1',
  uri: `agor://kb/team/${id}.md`,
  path: `${id}.md`,
  title: `Doc ${id}`,
  updated_at: '2026-09-01T00:00:00.000Z',
});

function renderSection(find: ReturnType<typeof vi.fn>) {
  const client = { service: vi.fn(() => ({ find })) } as unknown as AgorClient;
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomeKnowledgeSection client={client} connected />} />
        <Route path="/knowledge" element={<div>Knowledge page</div>} />
      </Routes>
    </MemoryRouter>
  );
  return client;
}

describe('HomeKnowledgeSection', () => {
  it('requests only the most recent page and links to the full Knowledge page', async () => {
    const find = vi.fn().mockResolvedValue({
      total: 240,
      limit: HOME_KNOWLEDGE_LIMIT,
      skip: 0,
      data: [doc('a'), doc('b')],
    });
    const client = renderSection(find);

    expect(await screen.findByText('Doc a')).toBeTruthy();
    expect(client.service).toHaveBeenCalledWith('kb/documents');
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({
      query: { archived: false, $limit: HOME_KNOWLEDGE_LIMIT, $sort: { updated_at: -1 } },
    });

    fireEvent.click(screen.getByRole('button', { name: 'View all 240' }));
    expect(await screen.findByText('Knowledge page')).toBeTruthy();
  });

  it('omits the count when every doc is already shown', async () => {
    renderSection(vi.fn().mockResolvedValue({ total: 1, limit: 50, skip: 0, data: [doc('a')] }));

    expect(await screen.findByText('Doc a')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View all' })).toBeTruthy();
  });
});
