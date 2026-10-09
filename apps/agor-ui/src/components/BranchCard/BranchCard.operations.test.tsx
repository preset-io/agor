import { generateId } from '@agor/core/ids/browser';
import type { Branch, BranchArchiveOrDeleteOptions, Repo, Session } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { useProgressiveMount } from '../../hooks/useProgressiveMount';
import type { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import BranchCard from './BranchCard';
import type { BranchSessionSections } from './BranchSessionSections';

vi.mock('../../hooks/useProgressiveMount', () => ({ useProgressiveMount: vi.fn(() => true) }));

// Eligibility/confirmation are owned and tested by the modal. Exercise the
// card's confirmation boundary without requiring a daemon or changing RBAC.
vi.mock('../ArchiveDeleteBranchModal', () => ({
  ArchiveDeleteBranchModal: ({
    open,
    onConfirm,
  }: ComponentProps<typeof ArchiveDeleteBranchModal>) =>
    open ? (
      <div role="dialog" aria-label="Archive or delete">
        <button
          type="button"
          onClick={() => onConfirm({ metadataAction: 'archive', filesystemAction: 'deleted' })}
        >
          Confirm archive
        </button>
        <button
          type="button"
          onClick={() => onConfirm({ metadataAction: 'delete', filesystemAction: 'deleted' })}
        >
          Confirm delete
        </button>
      </div>
    ) : null,
}));

vi.mock('./BranchSessionSections', () => ({
  BranchSessionSections: ({
    sessions,
    onSessionClick,
  }: ComponentProps<typeof BranchSessionSections>) => (
    <section aria-label="Branch sessions">
      {sessions.map((session) => (
        <button
          key={session.session_id}
          type="button"
          onClick={() => onSessionClick?.(session.session_id)}
        >
          {session.title}
        </button>
      ))}
    </section>
  ),
}));
vi.mock('./BranchSessionPeekSection', () => ({
  BranchSessionPeekSection: () => <section aria-label="Session previews">Preview content</section>,
}));

const branch = {
  branch_id: generateId(),
  repo_id: generateId(),
  name: 'feature/operation-states',
  filesystem_status: 'ready',
  archived: false,
} as Branch;
const repo = { repo_id: branch.repo_id, slug: 'fictional/repo' } as Repo;
const session = {
  session_id: generateId(),
  branch_id: branch.branch_id,
  title: 'Existing conversation',
  status: 'idle',
  archived: false,
} as Session;
const connected = {
  connected: true,
  connecting: false,
  authGeneration: 0,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

type Props = ComponentProps<typeof BranchCard>;
function view(props: Partial<Props> = {}) {
  return (
    <ConnectionProvider value={connected}>
      <BranchCard
        branch={branch}
        repo={repo}
        sessions={[session]}
        userById={new Map()}
        client={null}
        {...props}
      />
    </ConnectionProvider>
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function confirm(action: 'archive' | 'delete') {
  fireEvent.click(
    screen.getByRole('button', { name: /Archive or delete branch|View deletion status/ })
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Confirm ${action}` }));
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(useProgressiveMount).mockReturnValue(true);
});

describe('BranchCard destructive operation states', () => {
  it.each(['archive', 'delete'] as const)(
    'keeps %s feedback and the spinner until the mutation settles, independently of sessions',
    async (action) => {
      const request = deferred();
      const onArchiveOrDelete = vi.fn(() => request.promise);
      const props = { onArchiveOrDelete, onOpenTerminal: vi.fn(), onOpenSettings: vi.fn() };
      localStorage.setItem(
        `agor:branch-card:peeked-session-ids:${branch.branch_id}`,
        JSON.stringify([session.session_id])
      );
      const mounted = render(view(props));
      expect(screen.getByRole('region', { name: 'Branch sessions' })).not.toBeNull();
      expect(screen.getByRole('region', { name: 'Session previews' })).not.toBeNull();
      expect(mounted.container.querySelector('.ant-spin-spinning')).toBeNull();

      await confirm(action);
      const status = screen.getByRole('status');
      expect(status.textContent).toContain(
        action === 'archive' ? 'Archiving branch…' : 'Deleting branch…'
      );
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Branch sessions' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Session previews' })).toBeNull();
      expect(screen.getByTitle('Archive or delete branch').hasAttribute('disabled')).toBe(true);
      expect(screen.getByTitle('Open terminal in branch directory').hasAttribute('disabled')).toBe(
        true
      );
      expect(screen.getByTitle('Edit branch').hasAttribute('disabled')).toBe(true);
      const configureEnvironment = screen.getByLabelText('Configure environment');
      expect(configureEnvironment.hasAttribute('disabled')).toBe(true);
      fireEvent.click(configureEnvironment);
      expect(props.onOpenSettings).not.toHaveBeenCalled();
      const spinner = mounted.container.querySelector('.ant-spin-spinning');
      expect(spinner).not.toBeNull();
      expect(onArchiveOrDelete).toHaveBeenCalledExactlyOnceWith(branch.branch_id, {
        metadataAction: action,
        filesystemAction: 'deleted',
      } satisfies BranchArchiveOrDeleteOptions);

      mounted.rerender(view({ ...props, sessions: [{ ...session, status: 'running' }] }));
      expect(mounted.container.querySelector('.ant-spin-spinning')).toBe(spinner);
      // Realtime can archive/remove all sessions before the request finishes.
      mounted.rerender(view({ ...props, branch: { ...branch }, sessions: [] }));
      expect(screen.getByRole('status')).toBe(status);
      expect(mounted.container.querySelector('.ant-spin-spinning')).toBe(spinner);
      fireEvent.click(screen.getByTitle('Archive or delete branch'));
      expect(onArchiveOrDelete).toHaveBeenCalledTimes(1);

      await act(async () => request.resolve());
      expect(screen.queryByRole('status')).toBeNull();
      expect(mounted.container.querySelector('.ant-spin-spinning')).toBeNull();
      expect(screen.getByRole('region', { name: 'Branch sessions' })).not.toBeNull();
      expect(screen.getByTitle('Edit branch').hasAttribute('disabled')).toBe(false);
      fireEvent.click(screen.getByLabelText('Configure environment'));
      expect(props.onOpenSettings).toHaveBeenCalledWith(branch.branch_id);
    }
  );

  it.each(['archive', 'delete'] as const)(
    'restores sessions and allows retry after %s rejects',
    async (action) => {
      const request = deferred();
      const onArchiveOrDelete = vi.fn(() => request.promise);
      const onSessionClick = vi.fn();
      const mounted = render(view({ onArchiveOrDelete, onSessionClick }));
      await confirm(action);
      await act(async () => request.reject(new Error('Already reported by mutation owner')));

      expect(screen.queryByRole('status')).toBeNull();
      expect(mounted.container.querySelector('.ant-spin-spinning')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: session.title }));
      expect(onSessionClick).toHaveBeenCalledWith(session.session_id);
      onArchiveOrDelete.mockResolvedValue(undefined);
      await confirm(action);
      expect(onArchiveOrDelete).toHaveBeenCalledTimes(2);
    }
  );

  it('continues persisted deletion after acceptance and restores failure details and retry', async () => {
    const request = deferred();
    const onArchiveOrDelete = vi.fn(() => request.promise);
    const mounted = render(view({ onArchiveOrDelete }));
    await confirm('delete');
    mounted.rerender(
      view({ onArchiveOrDelete, branch: { ...branch, deletion_status: 'deleting' } })
    );
    await act(async () => request.resolve());
    expect(screen.getByRole('status').textContent).toContain('Deleting branch…');
    expect(mounted.container.querySelector('.ant-spin-spinning')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Branch sessions' })).toBeNull();

    mounted.rerender(
      view({
        onArchiveOrDelete,
        branch: {
          ...branch,
          deletion_status: 'deletion_failed',
          deletion_error: 'Cleanup requires reconciliation',
        },
      })
    );
    expect(screen.getByRole('status').textContent).toContain('Deletion failed');
    expect(screen.getByText('Cleanup requires reconciliation')).not.toBeNull();
    expect(mounted.container.querySelector('.ant-spin-spinning')).toBeNull();
    expect(screen.getByRole('region', { name: 'Branch sessions' })).not.toBeNull();
    expect(screen.getByTitle('View deletion status or retry').hasAttribute('disabled')).toBe(false);

    const retry = deferred();
    onArchiveOrDelete.mockReturnValue(retry.promise);
    await confirm('delete');
    expect(screen.queryByText('Cleanup requires reconciliation')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Deleting branch…');
    await act(async () => retry.reject(new Error('Still blocked')));
    expect(screen.getByText('Cleanup requires reconciliation')).not.toBeNull();
  });

  it.each([{ panelMode: true }, { inPopover: true }, {}])(
    'shows persisted deletion on every surface: %j',
    (surface) => {
      const mounted = render(
        view({ ...surface, branch: { ...branch, deletion_status: 'deleting' } })
      );
      expect(screen.getByRole('status').textContent).toContain('Deleting branch…');
      expect(mounted.container.querySelector('.ant-spin-spinning')).not.toBeNull();
      expect(screen.queryByRole('region', { name: 'Branch sessions' })).toBeNull();
    }
  );

  it('replaces the deferred session shell immediately, without waiting for hydration', async () => {
    vi.mocked(useProgressiveMount).mockReturnValue(false);
    const request = deferred();
    render(view({ onArchiveOrDelete: () => request.promise }));
    expect(screen.getByText('Sessions (1)')).not.toBeNull();
    await confirm('archive');
    expect(screen.queryByText('Sessions (1)')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Archiving branch…');
    await act(async () => request.resolve());
    expect(screen.getByText('Sessions (1)')).not.toBeNull();
  });

  it('keeps pending state local to the branch that initiated the operation', async () => {
    const request = deferred();
    render(view({ onArchiveOrDelete: () => request.promise }));
    const otherBranch = { ...branch, branch_id: generateId(), name: 'Another branch' };
    const other = render(
      view({ branch: otherBranch, sessions: [{ ...session, branch_id: otherBranch.branch_id }] })
    );
    await confirm('archive');
    expect(screen.getByRole('status').textContent).toContain('Archiving branch…');
    expect(other.container.querySelector('[aria-label="Branch sessions"]')).not.toBeNull();
    expect(other.container.querySelector('.ant-spin-spinning')).toBeNull();
    await act(async () => request.resolve());
  });

  it('clears pending state for synchronous handlers and synchronous errors', async () => {
    const onArchiveOrDelete = vi.fn(() => {});
    render(view({ onArchiveOrDelete }));
    await confirm('archive');
    expect(screen.queryByRole('status')).toBeNull();
    onArchiveOrDelete.mockImplementation(() => {
      throw new Error('Synchronous failure');
    });
    await confirm('delete');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('region', { name: 'Branch sessions' })).not.toBeNull();
  });
});
