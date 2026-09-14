import { act, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EnvVarEditor } from './EnvVarEditor';

function renderEditor(envVars: ComponentProps<typeof EnvVarEditor>['envVars']) {
  const props = {
    envVars,
    onSave: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    identityKey: 'user-a:member',
    operationScope: ['user-a:member', 1],
  };

  return render(
    <AntApp>
      <EnvVarEditor {...props} />
    </AntApp>
  );
}

describe('EnvVarEditor', () => {
  it('sorts existing environment variables alphabetically by key without mutating props', () => {
    const envVars = {
      Z_TOKEN: { set: true, scope: 'global' },
      alpha_TOKEN: { set: true, scope: 'session' },
      BETA_TOKEN: true,
    } satisfies ComponentProps<typeof EnvVarEditor>['envVars'];
    const originalKeys = Object.keys(envVars);

    renderEditor(envVars);

    const renderedKeys = screen.getAllByText(/_TOKEN$/).map((node) => node.textContent);
    expect(renderedKeys).toEqual(['alpha_TOKEN', 'BETA_TOKEN', 'Z_TOKEN']);
    expect(Object.keys(envVars)).toEqual(originalKeys);
  });

  it('preserves a same-user reconnect draft while invalidating the old save', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const onSave = vi.fn(() => pending);
    const view = (identityKey: string, generation: number) => (
      <AntApp>
        <EnvVarEditor
          envVars={{}}
          onSave={onSave}
          onDelete={vi.fn(async () => {})}
          identityKey={identityKey}
          operationScope={[identityKey, generation]}
        />
      </AntApp>
    );
    const rendered = render(view('member-a:member', 2));
    fireEvent.change(screen.getByPlaceholderText(/variable name/i), {
      target: { value: 'PRIVATE_TOKEN' },
    });
    fireEvent.change(screen.getByPlaceholderText('Value'), {
      target: { value: 'member-a-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onSave).toHaveBeenCalledWith('PRIVATE_TOKEN', 'member-a-secret', 'global');

    rendered.rerender(view('member-a:member', 3));
    await act(async () => {
      resolve();
      await pending;
    });
    expect(screen.getByPlaceholderText(/variable name/i)).toHaveValue('PRIVATE_TOKEN');
    expect(screen.getByPlaceholderText('Value')).toHaveValue('member-a-secret');

    rendered.rerender(view('member-b:member', 4));
    expect(screen.getByPlaceholderText(/variable name/i)).toHaveValue('');
    expect(screen.getByPlaceholderText('Value')).toHaveValue('');
  });
});
