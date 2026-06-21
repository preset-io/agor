import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EnvVarEditor } from './EnvVarEditor';

function renderEditor(envVars: ComponentProps<typeof EnvVarEditor>['envVars']) {
  const props = {
    envVars,
    onSave: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
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
});
