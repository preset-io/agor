import { act, fireEvent, render, screen } from '@testing-library/react';
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
});
