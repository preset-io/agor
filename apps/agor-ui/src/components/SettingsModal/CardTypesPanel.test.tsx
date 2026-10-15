import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CardTypesPanel } from './CardTypesPanel';
import { StandaloneSettingsDrillProvider } from './SettingsDrill';

// The real editor needs the app ThemeProvider; a textarea is enough for form behaviour.
vi.mock('../JSONEditor', async () => ({
  ...(await vi.importActual<typeof import('../JSONEditor')>('../JSONEditor')),
  JSONEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

function renderPanel(create: () => unknown) {
  const client = {
    service: vi.fn(() => ({ create: vi.fn(create) })),
  } as unknown as AgorClient;
  render(
    <MemoryRouter>
      <StandaloneSettingsDrillProvider section="card-types">
        <CardTypesPanel client={client} cardTypeById={new Map()} />
      </StandaloneSettingsDrillProvider>
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: /New Type/ }));
  return client;
}

describe('CardTypesPanel', () => {
  it('keeps the create form open with the failure inline and flags invalid schema JSON', async () => {
    renderPanel(() => {
      throw new Error('Failed to create card type: SQLITE_BUSY: database is locked');
    });
    fireEvent.change(await screen.findByPlaceholderText('e.g. Support Ticket'), {
      target: { value: 'Bug' },
    });
    fireEvent.click(screen.getByRole('switch'));
    const schema = screen.getByPlaceholderText('{"type": "object", "properties": {...}}');
    fireEvent.change(schema, { target: { value: '{"type":' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText("The schema isn't valid JSON.")).toBeVisible();

    fireEvent.change(schema, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText("Couldn't create the card type.")).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(
      screen.getByText('Failed to create card type: SQLITE_BUSY: database is locked')
    ).toBeVisible();
    expect(screen.getByPlaceholderText('e.g. Support Ticket')).toHaveValue('Bug');
  });

  it('blocks a second create after a lost reply until the form changes', async () => {
    const create = vi.fn(() => {
      throw new Error('socket has been disconnected');
    });
    renderPanel(create);
    const name = await screen.findByPlaceholderText('e.g. Support Ticket');
    fireEvent.change(name, { target: { value: 'Bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText(
        'The connection to Agor dropped before this was confirmed. Refresh to see if it went through before you try to create the card type again.'
      )
    ).toBeVisible();
    // The frame publishes saveDisabled to the shell footer after it renders.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(create).toHaveBeenCalledOnce();
    fireEvent.change(name, { target: { value: 'Bug 2' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
  });
});
