import type { AgorClient, Session, Task } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionQueue, type SessionQueueProps } from './SessionQueue';

const task = (id: string, prompt: string) =>
  ({ task_id: id, full_prompt: prompt, status: 'queued' }) as unknown as Task;

const queued = [task('a', 'Update the docs'), task('b', 'Run the e2e suite'), task('c', 'Tidy')];

function setup(props: Partial<SessionQueueProps> = {}) {
  const reorderQueued = vi.fn().mockResolvedValue({});
  const remove = vi.fn().mockResolvedValue({});
  const patch = vi.fn().mockResolvedValue({});
  const client = {
    service: (name: string) => (name === 'tasks' ? { reorderQueued, remove } : { patch }),
  } as unknown as AgorClient;
  const onStop = vi.fn();
  const onEdit = vi.fn();
  render(
    <App>
      <SessionQueue
        client={client}
        session={{ session_id: 's1', status: 'running' } as Session}
        queuedTasks={queued}
        isRunning
        onStop={onStop}
        onEdit={onEdit}
        {...props}
      />
    </App>
  );
  return { reorderQueued, remove, patch, onStop, onEdit };
}

const expand = () => fireEvent.click(screen.getByRole('button', { name: /3 queued/ }));

const openRowMenu = async (n: number) => {
  fireEvent.click(screen.getByLabelText(`More actions, message ${n}`));
  await screen.findAllByRole('menuitem');
};

beforeEach(() => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
});
afterEach(() => vi.restoreAllMocks());

describe('SessionQueue', () => {
  it('folds to "3 queued" and expands to rows', () => {
    setup();
    const header = screen.getByRole('button', { name: /3 queued/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Run the e2e suite')).not.toBeInTheDocument();
    expand();
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Run the e2e suite')).toBeInTheDocument();
  });

  it('renders nothing without queued messages', () => {
    const { container } = render(
      <SessionQueue
        client={null}
        session={{ session_id: 's1', status: 'idle' } as Session}
        queuedTasks={[]}
        isRunning={false}
        onStop={vi.fn()}
        onEdit={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('Send now moves the message to the front, then stops the current turn', async () => {
    const { reorderQueued, onStop } = setup();
    expand();
    fireEvent.click(screen.getByLabelText('Send now, message 3'));
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
    expect(reorderQueued).toHaveBeenCalledWith({
      session_id: 's1',
      expected_task_ids: ['a', 'b', 'c'],
      task_ids: ['c', 'a', 'b'],
    });
    expect(reorderQueued.mock.invocationCallOrder[0]).toBeLessThan(
      onStop.mock.invocationCallOrder[0]
    );
  });

  it('moves a message up and down from its menu', async () => {
    const { reorderQueued } = setup();
    expand();
    await openRowMenu(2);
    fireEvent.click(screen.getByLabelText('Move up, message 2'));
    await waitFor(() =>
      expect(reorderQueued).toHaveBeenLastCalledWith(
        expect.objectContaining({ task_ids: ['b', 'a', 'c'] })
      )
    );
    await openRowMenu(2);
    fireEvent.click(screen.getByLabelText('Move down, message 2'));
    await waitFor(() =>
      expect(reorderQueued).toHaveBeenLastCalledWith(
        expect.objectContaining({ task_ids: ['a', 'c', 'b'] })
      )
    );
  });

  it('Edit in composer removes the message and puts its text back', async () => {
    const { remove, onEdit } = setup();
    expand();
    await openRowMenu(1);
    fireEvent.click(screen.getByLabelText('Edit in composer, message 1'));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith('Update the docs'));
    expect(remove).toHaveBeenCalledWith('a');
  });

  it('removes a message', async () => {
    const { remove } = setup();
    expand();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove from queue, message 2'));
    });
    expect(remove).toHaveBeenCalledWith('b');
  });

  it('keeps Run next and Resume queue for a failure-held queue', async () => {
    const { patch, reorderQueued, onStop } = setup({
      session: { session_id: 's1', status: 'failed' } as Session,
      isRunning: false,
    });
    expect(screen.getByRole('button', { name: 'Resume queue' })).toBeInTheDocument();
    expand();
    expect(screen.getByText('Queue paused by failed session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run next' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Send now, message 2'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('s1', { ready_for_prompt: true }));
    expect(reorderQueued).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });
});
