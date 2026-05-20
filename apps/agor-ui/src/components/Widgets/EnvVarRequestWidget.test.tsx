/**
 * EnvVarRequestWidget — UI tests.
 *
 * Covers:
 *   - Pending state renders one password input per name + a scope selector +
 *     Save/Dismiss buttons.
 *   - Submitting calls POST /widgets/:id/submit with the correct body shape
 *     (values + scope).
 *   - Dismissing calls POST /widgets/:id/dismiss.
 *   - Terminal states (submitted / dismissed / already_present) render their
 *     read-only summary instead of the form.
 */

import type { Message, WidgetMessageMetadata } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EnvVarRequestWidget } from './EnvVarRequestWidget';

/** Wrap with Ant Design's App so `useThemedMessage` finds a message instance. */
function renderWithApp(ui: ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

function makeMessage(widget: WidgetMessageMetadata): Message {
  return {
    message_id: widget.widget_id,
    session_id: 'sess-1' as never,
    type: 'widget_request',
    role: 'system',
    index: 0,
    timestamp: '2026-05-19T12:00:00.000Z',
    content: 'Please provide env vars',
    content_preview: 'Please provide env vars',
    metadata: { widget },
  } as unknown as Message;
}

function makeWidget(
  overrides: Partial<WidgetMessageMetadata> & { params?: Record<string, unknown> } = {}
): WidgetMessageMetadata {
  const { params: paramOverrides, ...rest } = overrides;
  return {
    widget_id: 'wid-1' as never,
    widget_type: 'env_vars',
    schema_version: 1,
    status: 'pending',
    requested_at: '2026-05-19T12:00:00.000Z',
    auto_resume: true,
    params: {
      names: ['HUBSPOT_API_KEY'],
      reason: 'Needed to call the Hubspot API.',
      default_scope: 'global',
      ...(paramOverrides ?? {}),
    },
    ...rest,
  } as WidgetMessageMetadata;
}

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ widget_id: 'wid-1', status: 'submitted' }),
    text: async () => 'ok',
  })) as unknown as ReturnType<typeof vi.fn>;
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('EnvVarRequestWidget — pending state', () => {
  it('renders one password input per requested name', () => {
    const widget = makeWidget({
      params: {
        names: ['HUBSPOT_API_KEY', 'STRIPE_SECRET_KEY'],
        reason: 'two integrations',
        default_scope: 'global',
      },
    });
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);
    expect(screen.getByLabelText(/Value for HUBSPOT_API_KEY/i)).toBeTruthy();
    expect(screen.getByLabelText(/Value for STRIPE_SECRET_KEY/i)).toBeTruthy();
  });

  it('disables Save until every field has a value', () => {
    const widget = makeWidget();
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByLabelText(/Value for HUBSPOT_API_KEY/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shh' } });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits via POST /widgets/:id/submit with the typed values + chosen scope', async () => {
    const widget = makeWidget();
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);

    const input = screen.getByLabelText(/Value for HUBSPOT_API_KEY/i);
    fireEvent.change(input, { target: { value: 'secret-key' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/widgets\/wid-1\/submit$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      values: { HUBSPOT_API_KEY: 'secret-key' },
      scope: 'global', // default_scope was 'global'; no scope change in this test
    });
  });

  it('dismisses via POST /widgets/:id/dismiss with an empty body', async () => {
    const widget = makeWidget();
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/widgets\/wid-1\/dismiss$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('re-enables Save after a failed submit so the user can retry', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ message: 'Invalid env var' }),
      text: async () => 'Invalid env var',
    }));
    const widget = makeWidget();
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);
    fireEvent.change(screen.getByLabelText(/Value for HUBSPOT_API_KEY/i), {
      target: { value: 'shh' },
    });
    const saveBtn = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.click(saveBtn);

    // After the failed POST resolves, the button should NOT be stuck in
    // loading/disabled — the user can fix and retry. (Error itself surfaces
    // via the global toast, not an inline Alert.)
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('EnvVarRequestWidget — terminal states', () => {
  it('renders the submitted summary with names + scope', () => {
    const widget = makeWidget({
      status: 'submitted',
      resolved_at: '2026-05-19T12:34:56.000Z',
      result_meta: { names_submitted: ['HUBSPOT_API_KEY'], scope: 'global' },
    });
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);
    expect(screen.getByText(/HUBSPOT_API_KEY/i)).toBeTruthy();
    expect(screen.getByText(/saved/i)).toBeTruthy();
    expect(screen.getByText(/global/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('renders the dismissed summary', () => {
    const widget = makeWidget({ status: 'dismissed' });
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);
    expect(screen.getByText(/dismissed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('renders the already_present summary', () => {
    const widget = makeWidget({ status: 'already_present' });
    renderWithApp(<EnvVarRequestWidget message={makeMessage(widget)} widget={widget} />);
    expect(screen.getByText(/already configured/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
