import type { Session } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import { SessionSettingsModal } from './SessionSettingsModal';

checkBrowserSanity();
afterEach(() => {
  cleanup();
  agorStore.getState().reset();
});

const session = {
  session_id: '018f0000-0000-7000-8000-000000000101',
  agentic_tool: 'claude-code',
  title: 'Fixture coordinator',
  created_by: 'fixture-user',
  permission_config: { mode: 'acceptEdits' },
  callback_config: {
    enabled: true,
    callback_mode: 'once',
    callback_session_id: '018f0000-0000-7000-8000-000000000102',
    callback_created_by: 'fixture-user',
    include_original_prompt: true,
  },
} as Session;

it('saves persistent one-hop mode, preserves routing, and allows switching back to once', async () => {
  const onUpdate = vi.fn();
  const view = render(
    <AppActionsProvider value={{}}>
      <SessionSettingsModal open onClose={vi.fn()} session={session} onUpdate={onUpdate} />
    </AppActionsProvider>
  );
  await act(() => page.getByText('Callbacks', { exact: true }).click());
  await waitFor(() =>
    expect(screen.getByText(/C completes → B processes the result/)).toBeVisible()
  );
  await act(() => page.getByRole('combobox', { name: 'Callback mode' }).click());
  await act(() => userEvent.keyboard('{ArrowUp}{Enter}'));
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Callback mode' }).closest('.ant-select')
    ).toHaveTextContent('Persistent — every completion until unlinked')
  );
  await act(() => page.getByRole('button', { name: 'Save', exact: true }).click());
  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(
      session.session_id,
      expect.objectContaining({
        callback_config: {
          ...session.callback_config,
          callback_mode: 'persistent',
          include_last_message: true,
          template: undefined,
        },
      })
    )
  );

  view.unmount();
  const saved = {
    ...session,
    callback_config: { ...session.callback_config, callback_mode: 'persistent' as const },
  };
  render(
    <AppActionsProvider value={{}}>
      <SessionSettingsModal open onClose={vi.fn()} session={saved} onUpdate={onUpdate} />
    </AppActionsProvider>
  );
  await act(() => page.getByText('Callbacks', { exact: true }).click());
  await waitFor(() =>
    expect(screen.getByText('Persistent — every completion until unlinked')).toBeVisible()
  );
  await act(() => page.getByRole('combobox', { name: 'Callback mode' }).click());
  // Let native pointer/focus events flush between mousedown and click; wrapping
  // the entire browser action in React act batches AntD's popup updates.
  await userEvent.click(screen.getByRole('option', { name: 'Once — next completion only' }));
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Callback mode' }).closest('.ant-select')
    ).toHaveTextContent('Once — next completion only')
  );
  await act(() => page.getByRole('button', { name: 'Save', exact: true }).click());
  await waitFor(() =>
    expect(onUpdate).toHaveBeenLastCalledWith(
      session.session_id,
      expect.objectContaining({
        callback_config: expect.objectContaining({ ...session.callback_config }),
      })
    )
  );
});
