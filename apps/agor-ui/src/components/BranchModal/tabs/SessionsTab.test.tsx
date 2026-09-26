import type { AgorClient, Branch, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { expect, it, vi } from 'vitest';
import { SessionsTab } from './SessionsTab';

it('keeps cross-branch archive response rows out of the branch modal', async () => {
  const root = {
    session_id: 'root',
    branch_id: 'home',
    title: 'Home root',
    archived: false,
    status: 'idle',
    agentic_tool: 'codex',
    created_at: new Date().toISOString(),
    tasks: [],
  } as unknown as Session;
  const remote = {
    ...root,
    session_id: 'remote',
    branch_id: 'away',
    title: 'Remote child',
    archived: true,
  };
  const archived = { ...root, archived: true };
  let didArchive = false;
  const create = vi.fn(async () => {
    didArchive = true;
    return { session: archived, affectedSessions: [archived, remote], count: 2 };
  });
  const service = {
    findAll: vi.fn(async ({ query }: { query: { archived: boolean } }) =>
      query.archived ? [] : didArchive ? [] : [root]
    ),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const client = {
    service: (path: string) => (path === 'sessions' ? service : { create }),
  } as unknown as AgorClient;
  render(
    <App>
      <SessionsTab
        branch={{ branch_id: 'home', archived: false } as Branch}
        sessions={[root]}
        client={client}
      />
    </App>
  );
  await screen.findByText('Home root');
  // Load the archived cache first so the assertion exercises response reconciliation,
  // rather than replacing it with a subsequent server fetch.
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('disabled')).toBeNull());
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() =>
    expect(service.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ archived: true }) })
    )
  );
  fireEvent.click(screen.getByRole('button', { name: 'archive session and child sessions' }));
  await screen.findByText('Archive session and descendants?');
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  await screen.findByRole('button', { name: 'unarchive session and child sessions' });
  expect(screen.getByText('Home root')).toBeTruthy();
  expect(screen.queryByText('Remote child')).toBeNull();
});
