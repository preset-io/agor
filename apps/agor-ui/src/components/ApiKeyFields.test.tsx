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

describe('ApiKeyFields — save honors the displayed value (no silent auto-fix)', () => {
  it('saves the value WITH the internal space when the user did not opt into the fix', async () => {
    const { onSave } = renderFields();
    const input = screen.getByPlaceholderText('sk-ant-api03-...');

    fireEvent.change(input, { target: { value: DIRTY } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    // Not silently cleaned — saved as displayed (only always-safe edge cleanup).
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('ANTHROPIC_API_KEY', DIRTY));
  });

  it('offers "Clean it up" on blur, and after clicking it, Save persists the cleaned value', async () => {
    const { onSave } = renderFields();
    const input = screen.getByPlaceholderText('sk-ant-api03-...');

    fireEvent.change(input, { target: { value: DIRTY } });
    fireEvent.blur(input);

    const cleanBtn = await screen.findByRole('button', { name: /clean it up/i });
    fireEvent.click(cleanBtn);

    const saveButton = screen.getAllByRole('button', { name: /^save$/i })[0];
    fireEvent.click(saveButton);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('ANTHROPIC_API_KEY', CLEAN));
  });
});
