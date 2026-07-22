import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ApiKeyFields } from './ApiKeyFields';

function renderFields(overrides?: Partial<Parameters<typeof ApiKeyFields>[0]>) {
  const onSave = vi.fn(async () => {});
  const onClear = vi.fn(async () => {});
  render(
    <AntApp>
      <ApiKeyFields
        tool="claude-code"
        fieldStatus={{}}
        onSave={onSave}
        onClear={onClear}
        {...overrides}
      />
    </AntApp>
  );
  return { onSave, onClear };
}

const DIRTY = 'sk-ant-api03-abc DEF0123456789';
const CLEAN = 'sk-ant-api03-abcDEF0123456789';

describe('ApiKeyFields — save-path normalization', () => {
  it('normalizes a mid-token space before saving when pressing Enter', async () => {
    const { onSave } = renderFields();
    const input = screen.getByPlaceholderText('sk-ant-api03-...');

    fireEvent.change(input, { target: { value: DIRTY } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('ANTHROPIC_API_KEY', CLEAN));
  });

  it('normalizes before saving when clicking Save', async () => {
    const { onSave } = renderFields();
    const input = screen.getByPlaceholderText('sk-ant-api03-...');

    fireEvent.change(input, { target: { value: DIRTY } });
    const saveButton = screen.getAllByRole('button', { name: /^save$/i })[0];
    fireEvent.click(saveButton);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('ANTHROPIC_API_KEY', CLEAN));
  });
});
