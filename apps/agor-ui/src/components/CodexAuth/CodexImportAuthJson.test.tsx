import type { AgorClient, CodexAuthImportResult } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexImportAuthJson } from './CodexImportAuthJson';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('CodexImportAuthJson authority lifetime', () => {
  it('preserves a same-user reconnect draft, cancels the old import, and releases loading', async () => {
    const pending = deferred<CodexAuthImportResult>();
    const create = vi.fn(() => pending.promise);
    const client = {
      service: vi.fn(() => ({ create })),
    } as unknown as AgorClient;
    const onImported = vi.fn();
    const view = (generation: number) => (
      <CodexImportAuthJson
        client={client}
        identityKey="admin-a:admin"
        operationScope={['admin-a:admin', client, generation]}
        onImported={onImported}
      />
    );
    const rendered = render(view(1));
    const input = screen.getByLabelText('Codex auth.json contents');
    fireEvent.change(input, { target: { value: '{"tokens":"admin-a-secret"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import login' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: /Import login$/ })).toHaveClass('ant-btn-loading');

    rendered.rerender(view(2));
    expect(screen.getByLabelText('Codex auth.json contents')).toHaveValue(
      '{"tokens":"admin-a-secret"}'
    );
    expect(screen.getByRole('button', { name: /Import login$/ })).not.toHaveClass(
      'ant-btn-loading'
    );

    await act(async () => {
      pending.resolve({ status: 'authenticated', authMode: 'chatgpt' });
      await pending.promise;
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Codex auth.json contents')).toHaveValue(
      '{"tokens":"admin-a-secret"}'
    );
  });

  it('erases A credentials and drops A continuation on same-role identity replacement', async () => {
    const pending = deferred<CodexAuthImportResult>();
    const create = vi.fn(() => pending.promise);
    const client = {
      service: vi.fn(() => ({ create })),
    } as unknown as AgorClient;
    const onImported = vi.fn();
    const view = (identityKey: string, generation: number) => (
      <CodexImportAuthJson
        client={client}
        identityKey={identityKey}
        operationScope={[identityKey, client, generation]}
        onImported={onImported}
      />
    );
    const rendered = render(view('admin-a:admin', 8));
    fireEvent.change(screen.getByLabelText('Codex auth.json contents'), {
      target: { value: '{"tokens":"admin-a-secret"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import login' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());

    rendered.rerender(view('admin-b:admin', 9));
    expect(screen.getByLabelText('Codex auth.json contents')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Import login$/ })).not.toHaveClass(
      'ant-btn-loading'
    );

    await act(async () => {
      pending.resolve({ status: 'authenticated', authMode: 'chatgpt' });
      await pending.promise;
    });
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Codex auth.json contents')).toHaveValue('');
  });
});
