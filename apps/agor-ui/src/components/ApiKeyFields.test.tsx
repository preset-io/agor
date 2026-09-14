import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ApiKeyFields } from './ApiKeyFields';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ApiKeyFields authority fencing', () => {
  it('keeps a same-user reconnect draft but drops the obsolete save continuation', async () => {
    const pending = deferred();
    const onSave = vi.fn(() => pending.promise);
    const view = (identityKey: string, generation: number) => (
      <AntApp>
        <ApiKeyFields
          tool="claude-code"
          fields={[
            {
              field: 'ANTHROPIC_API_KEY',
              label: 'Anthropic API key',
              placeholder: 'sk-ant-...',
            },
          ]}
          fieldStatus={{}}
          onSave={onSave}
          onClear={vi.fn(async () => {})}
          identityKey={identityKey}
          operationScope={[identityKey, generation]}
        />
      </AntApp>
    );
    const rendered = render(view('admin-a:admin', 4));
    const input = screen.getByPlaceholderText('sk-ant-...');
    fireEvent.change(input, { target: { value: 'admin-a-private-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('ANTHROPIC_API_KEY', 'admin-a-private-key');

    rendered.rerender(view('admin-a:admin', 5));
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.getByPlaceholderText('sk-ant-...')).toHaveValue('admin-a-private-key');

    rendered.rerender(view('admin-b:admin', 6));
    expect(screen.getByPlaceholderText('sk-ant-...')).toHaveValue('');
  });
  it('preserves a failed credential draft for retry without leaking the server error', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('upstream rejected secret-example'))
      .mockResolvedValueOnce(undefined);
    render(
      <AntApp>
        <ApiKeyFields
          tool="gemini"
          fieldStatus={{}}
          onSave={onSave}
          onClear={vi.fn()}
          identityKey="user-a"
          operationScope={['user-a', 1]}
        />
      </AntApp>
    );
    const input = screen.getByPlaceholderText('AIza...');
    fireEvent.change(input, { target: { value: 'secret-example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(screen.queryByText(/upstream rejected/)).toBeNull();
    expect(input).toHaveValue('secret-example');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected clear without claiming the key is unset', async () => {
    const onClear = vi.fn().mockRejectedValue(new Error('denied'));
    render(
      <AntApp>
        <ApiKeyFields
          tool="gemini"
          fieldStatus={{ GEMINI_API_KEY: true }}
          onSave={vi.fn()}
          onClear={onClear}
          identityKey="user-a"
          operationScope={['user-a', 1]}
        />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('button', { name: /Clear$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not clear');
    expect(screen.getByText('Set')).toBeVisible();
  });
});
