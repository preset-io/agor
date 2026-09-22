import type { AgorClient } from '@agor-live/client';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { agorStore } from '../store/agorStore';
import { checkBrowserSanity } from '../test/browserSanity';
import { KnowledgePage } from './KnowledgePage';

checkBrowserSanity();
configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => {
  agorStore.getState().reset();
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(cleanup);

it('renders existing search success, empty, and error states without retries or text fallback', async () => {
  const find = vi.fn(async ({ query }: { query: { q: string; mode: string } }) => {
    if (query.q === 'failure') throw new Error('Semantic Knowledge search is disabled.');
    if (query.q !== 'needle') return [];
    return [
      {
        document: {
          document_id: 'search-document',
          namespace_id: 'search-namespace',
          title: 'Synthetic search hit',
          path: 'search.md',
          kind: 'doc',
          status: 'published',
        },
        namespace: { slug: 'global', display_name: 'Global' },
        snippet: 'Synthetic matching content',
        score: 1,
        mode: query.mode,
      },
    ];
  });
  const client = {
    service: (name: string) => ({
      find: name === 'kb/search' ? find : async () => [],
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    }),
  } as unknown as AgorClient;
  render(
    <ConfigProvider>
      <App>
        <MemoryRouter initialEntries={['/kb']}>
          <KnowledgePage client={client} />
        </MemoryRouter>
      </App>
    </ConfigProvider>
  );
  const input = page.getByPlaceholder('Search all Knowledge…');
  await input.fill('needle');
  await expect.element(page.getByText('Synthetic search hit')).toBeVisible();
  await userEvent.click(screen.getByText('Semantic'));
  await waitFor(() =>
    expect(find).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ q: 'needle', mode: 'semantic' }) })
    )
  );
  await input.fill('nothing');
  await expect.element(page.getByText('No Knowledge results')).toBeVisible();
  expect(screen.queryByText('Synthetic search hit')).not.toBeInTheDocument();
  await input.fill('failure');
  await expect.element(page.getByText('Semantic Knowledge search is disabled.')).toBeVisible();
  await waitFor(() => expect(document.querySelector('.ant-spin-spinning')).toBeNull());
  expect(find.mock.calls.filter(([params]) => params.query.q === 'failure')).toHaveLength(1);
  expect(find.mock.calls.at(-1)?.[0].query.mode).toBe('semantic');
});
