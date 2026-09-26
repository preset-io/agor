/** Real Chromium/AntD lifecycle; transport is mocked and no provider is invoked. */
import type { Session, SpawnConfig } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { SessionPanelContent } from './SessionPanelContent';

vi.mock('../ConversationView', () => ({ ConversationView: () => null }));
vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder?.startsWith('e.g.') ? 'Extra instructions' : 'Child prompt'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

async function click(element: HTMLElement) {
  await act(async () => {
    await userEvent.click(element);
  });
}
async function fill(element: HTMLElement, value: string) {
  await act(async () => {
    await userEvent.fill(element, value);
  });
}

const parent = {
  session_id: 'browser-parent',
  title: 'Parent',
  agentic_tool: 'codex',
  status: 'idle',
  permission_config: {
    mode: 'allow-all',
    codex: { sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccess: true },
  },
} as Session;

afterEach(cleanup);

it('reopens a mounted SessionPanel spawn modal after success and retains a rejected draft', async () => {
  const create = vi
    .fn<(config: string | Partial<SpawnConfig>) => Promise<void>>()
    .mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  function Harness() {
    const [open, setOpen] = useState(false);
    const [session, setSession] = useState(parent);
    const inputValueRef = useRef('');
    return (
      <App>
        <AppActionsProvider value={{}}>
          <button type="button" onClick={() => setOpen(true)}>
            Open spawn
          </button>
          <SessionPanelContent
            client={null}
            session={session}
            scrollToBottom={null}
            scrollToTop={null}
            setScrollToBottom={vi.fn()}
            setScrollToTop={vi.fn()}
            queuedTasks={[]}
            setQueuedTasks={vi.fn()}
            spawnModalOpen={open}
            setSpawnModalOpen={setOpen}
            onSpawnModalConfirm={async (config) => {
              await create(config);
              // SessionPanel's order: transport resolves, close, clear composer.
              setOpen(false);
              inputValueRef.current = '';
              setSession({ ...parent });
            }}
            inputValueRef={inputValueRef}
            isOpen
          />
        </AppActionsProvider>
      </App>
    );
  }
  render(<Harness />);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await click(screen.getByRole('button', { name: 'Open spawn' }));
    const submit = await screen.findByRole('button', { name: 'Spawn Session' }, { timeout: 5000 });
    await waitFor(() => expect(submit).not.toHaveClass('ant-btn-loading'));
    await fill(screen.getByRole('textbox', { name: 'Child prompt' }), `Child ${attempt}`);
    await click(screen.getByText('Custom config'));
    const network = await screen.findByRole('switch');
    expect(network).toHaveAttribute('aria-checked', 'true');
    if (attempt === 2) await click(network);
    await click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(attempt));
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: `Child ${attempt}`,
        codexNetworkAccess: attempt !== 2,
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => {
      const wrap = document.querySelector('.ant-modal-wrap');
      if (wrap) expect(wrap).not.toBeVisible();
    });
  }

  create.mockRejectedValueOnce(new Error('Transport rejected'));
  await click(screen.getByRole('button', { name: 'Open spawn' }));
  await fill(screen.getByRole('textbox', { name: 'Child prompt' }), 'Keep my draft');
  await click(screen.getByText('Custom config'));
  await click(await screen.findByRole('switch'));
  await fill(screen.getByRole('textbox', { name: 'Extra instructions' }), 'Keep my settings');
  await click(screen.getByRole('button', { name: 'Spawn Session' }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(4));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Spawn Session' })).not.toHaveClass('ant-btn-loading')
  );
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Child prompt' })).toHaveValue('Keep my draft');
  expect(screen.getByRole('textbox', { name: 'Extra instructions' })).toHaveValue(
    'Keep my settings'
  );
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await click(screen.getByRole('button', { name: 'Spawn Session' }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(5));
  expect(create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      prompt: 'Keep my draft',
      extraInstructions: 'Keep my settings',
      codexNetworkAccess: false,
    })
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => {
    const wrap = document.querySelector('.ant-modal-wrap');
    if (wrap) expect(wrap).not.toBeVisible();
  });
});
