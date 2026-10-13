import type { AgenticToolPreset, AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolPresetsManager } from './AgenticToolPresetsManager';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('AgenticToolPresetsManager authority lifetime', () => {
  it('releases a cancelled generation save while preserving the same-user form', async () => {
    const pending = deferred<AgenticToolPreset>();
    const find = vi.fn().mockResolvedValue([]);
    const create = vi.fn(() => pending.promise);
    const client = {
      service: vi.fn((path: string) => {
        if (path !== 'agentic-tool-presets') throw new Error(path);
        return { find, create, patch: vi.fn(), remove: vi.fn() };
      }),
    } as unknown as AgorClient;
    const onError = vi.fn();
    const view = (generation: number) => (
      <AgenticToolPresetsManager
        client={client}
        tool="claude-code"
        onError={onError}
        identityKey="admin-a:admin"
        operationScope={['admin-a:admin', client, generation]}
      />
    );
    const rendered = render(view(1));
    await screen.findByText('No presets');
    fireEvent.click(screen.getByRole('button', { name: /New preset$/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A reconnect draft' } });
    // Form validation makes the save handler async. Keep the interaction in an
    // async act boundary so React commits the pending-save render before the
    // test inspects it, independent of scheduler load in the sharded suite.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save$/ })).toHaveClass('ant-btn-loading')
    );

    rendered.rerender(view(2));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Name')).toHaveValue('A reconnect draft');
    expect(screen.getByRole('button', { name: /Save$/ })).not.toHaveClass('ant-btn-loading');

    await act(async () => {
      pending.resolve({
        preset_id: 'preset-a',
        tool: 'claude-code',
        name: 'A reconnect draft',
        configuration: {},
        is_default: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as AgenticToolPreset);
      await pending.promise;
    });
    // The obsolete save cannot close or overwrite the preserved draft.
    expect(screen.getByLabelText('Name')).toHaveValue('A reconnect draft');
    expect(find).toHaveBeenCalledTimes(2);
  });
});

describe('AgenticToolPresetsManager unsaved-changes guard', () => {
  it('asks before Cancel discards a preset draft, and leaves an untouched one at once', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const client = {
      service: vi.fn(() => ({ find, create: vi.fn(), patch: vi.fn(), remove: vi.fn() })),
    } as unknown as AgorClient;
    renderWithSettingsShell(
      <AgenticToolPresetsManager
        client={client}
        tool="claude-code"
        onError={vi.fn()}
        identityKey="admin:admin"
        operationScope={['admin:admin', client, 1]}
      />,
      'agentic-tools'
    );
    const confirms = () => document.querySelectorAll('.ant-modal-confirm').length;
    await screen.findByText('No presets');

    fireEvent.click(screen.getByRole('button', { name: /New preset$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByText('No presets')).toBeInTheDocument());
    expect(confirms()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /New preset$/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft preset' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(confirms()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Draft preset');
  });
});
