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

import type { AgorClient, Message, WidgetMessageMetadata } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { EnvVarRequestWidget } from './EnvVarRequestWidget';

/** Wrap with Ant Design's App so `useThemedMessage` finds a message instance. */
function renderWithApp(ui: ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

interface StubServiceCall {
  path: string;
  body: unknown;
}

/**
 * Minimal AgorClient stub — only the `service(path).create(body)` surface
 * the widget uses. Returns a `calls` array for assertions and a `shouldFail`
 * knob for negative tests.
 */
function makeStubClient(
  opts: {
    shouldFail?: boolean;
    fieldErrors?: Record<string, string>;
    envVars?: Record<string, { set: true; scope: 'global' | 'session' }>;
  } = {}
): {
  client: AgorClient;
  calls: StubServiceCall[];
} {
  const calls: StubServiceCall[] = [];
  const client = {
    service(path: string) {
      return {
        async get(id: string) {
          if (path === 'sessions' && id === 'sess-1') return { created_by: 'user-creator' };
          if (path === 'users' && id === 'user-creator') return { env_vars: opts.envVars ?? {} };
          return {};
        },
        async create(body: unknown) {
          calls.push({ path, body });
          if (opts.shouldFail) {
            const err = new Error('Invalid env var') as Error & {
              data?: { field_errors?: Record<string, string> };
            };
            if (opts.fieldErrors) err.data = { field_errors: opts.fieldErrors };
            throw err;
          }
          return { widget_id: 'wid-1', status: 'submitted' };
        },
      };
    },
  } as unknown as AgorClient;
  return { client, calls };
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
      ...(paramOverrides ?? {}),
    },
    ...rest,
  } as WidgetMessageMetadata;
}

describe('EnvVarRequestWidget — pending state', () => {
  it('renders one password input per requested name', () => {
    const widget = makeWidget({
      params: {
        names: ['HUBSPOT_API_KEY', 'STRIPE_SECRET_KEY'],
        reason: 'two integrations',
      },
    });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByLabelText(/Value for HUBSPOT_API_KEY/i)).toBeTruthy();
    expect(screen.getByLabelText(/Value for STRIPE_SECRET_KEY/i)).toBeTruthy();
    expect(screen.queryByText(/Not set/i)).toBeNull();
  });

  it('renders per-variable metadata and native input types', () => {
    const widget = makeWidget({
      params: {
        names: ['PUBLIC_BASE_URL', 'PRIVATE_NOTE'],
        reason: 'two values',
        variable_metadata: {
          PUBLIC_BASE_URL: {
            description: 'Public URL for callbacks.',
            placeholder: 'https://example.com',
            format_hint: 'Must include protocol.',
            input_type: 'text',
          },
          PRIVATE_NOTE: {
            description: 'Paste the multiline value.',
            input_type: 'textarea',
          },
        },
      },
    });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByText('Public URL for callbacks.')).toBeTruthy();
    expect(screen.getByPlaceholderText('https://example.com')).toBeTruthy();
    expect(screen.getByText('Must include protocol.')).toBeTruthy();
    expect(screen.getByText('Paste the multiline value.')).toBeTruthy();
  });

  it('renders requested names in deterministic order', () => {
    const widget = makeWidget({
      params: {
        names: ['STRIPE_SECRET_KEY', 'HUBSPOT_API_KEY'],
        reason: 'two integrations',
      },
    });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    const inputs = screen.getAllByLabelText(/Value for/i);
    expect(inputs.map((input) => input.getAttribute('aria-label'))).toEqual([
      'Value for HUBSPOT_API_KEY',
      'Value for STRIPE_SECRET_KEY',
    ]);
  });

  it('disables Save until every field has a value', () => {
    const widget = makeWidget();
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByLabelText(/Value for HUBSPOT_API_KEY/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shh' } });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits via widgets/:id/submit with the typed values + chosen scope', async () => {
    const widget = makeWidget();
    const { client, calls } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    const input = screen.getByLabelText(/Value for HUBSPOT_API_KEY/i);
    fireEvent.change(input, { target: { value: 'secret-key' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect(calls[0].path).toBe('widgets/wid-1/submit');
    expect(calls[0].body).toEqual({
      values: { HUBSPOT_API_KEY: 'secret-key' },
      use_existing: [],
      scope: 'global', // UI always starts at Global; no scope change in this test
    });
  });

  it('can use an existing saved global value without retyping it', async () => {
    const widget = makeWidget({
      params: {
        names: ['HUBSPOT_API_KEY', 'STRIPE_SECRET_KEY'],
        reason: 'two integrations',
      },
    });
    const { client, calls } = makeStubClient({
      envVars: { HUBSPOT_API_KEY: { set: true, scope: 'global' } },
    });
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    expect(await screen.findByText('Set (encrypted)')).toBeTruthy();
    fireEvent.click(await screen.findByLabelText(/Use saved encrypted value/i));
    fireEvent.change(screen.getByLabelText(/Value for STRIPE_SECRET_KEY/i), {
      target: { value: 'new-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect(calls[0].body).toEqual({
      values: { STRIPE_SECRET_KEY: 'new-secret' },
      use_existing: ['HUBSPOT_API_KEY'],
      scope: 'global',
    });
  });

  it('does not offer use-existing for session-scoped saved values', async () => {
    const widget = makeWidget({
      params: {
        names: ['HUBSPOT_API_KEY'],
        reason: 'call hubspot',
      },
    });
    const { client } = makeStubClient({
      envVars: { HUBSPOT_API_KEY: { set: true, scope: 'session' } },
    });
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    expect(await screen.findByText('Set (encrypted)')).toBeTruthy();
    expect(screen.queryByLabelText(/Use saved encrypted value/i)).toBeNull();
    expect(screen.getByText(/Session-scoped saved values/i)).toBeTruthy();
  });

  it('dismisses via widgets/:id/dismiss with an empty body', async () => {
    const widget = makeWidget();
    const { client, calls } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect(calls[0].path).toBe('widgets/wid-1/dismiss');
    expect(calls[0].body).toEqual({});
  });

  it('re-enables Save after a failed submit so the user can retry', async () => {
    const widget = makeWidget();
    const { client, calls } = makeStubClient({ shouldFail: true });
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
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
    expect(screen.getAllByText(/Save failed: Invalid env var/i).length).toBeGreaterThan(0);
    expect(calls.length).toBe(1);
  });

  it('attaches structured server field errors to the matching input row', async () => {
    const widget = makeWidget();
    const { client } = makeStubClient({
      shouldFail: true,
      fieldErrors: { HUBSPOT_API_KEY: 'Only global saved values can be used from this widget' },
    });
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    fireEvent.change(screen.getByLabelText(/Value for HUBSPOT_API_KEY/i), {
      target: { value: 'shh' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Only global saved values/i)).toBeTruthy();
    expect(screen.getAllByText(/Save failed: Invalid env var/i).length).toBeGreaterThan(0);
  });

  it('shows a local submitted summary after save so duplicate clicks cannot resubmit', async () => {
    const widget = makeWidget();
    const { client, calls } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    fireEvent.change(screen.getByLabelText(/Value for HUBSPOT_API_KEY/i), {
      target: { value: 'secret-key' },
    });
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText(/saved/i)).toBeTruthy();
    });
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('shows a reused-existing local summary when no new values were saved', async () => {
    const widget = makeWidget();
    const { client } = makeStubClient({
      envVars: { HUBSPOT_API_KEY: { set: true, scope: 'global' } },
    });
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    fireEvent.click(await screen.findByLabelText(/Use saved encrypted value/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Used existing HUBSPOT_API_KEY/i)).toBeTruthy();
    expect(screen.queryByText(/Saved HUBSPOT_API_KEY/i)).toBeNull();
  });

  it('shows a local dismissed summary after dismiss so duplicate clicks cannot resubmit', async () => {
    const widget = makeWidget();
    const { client, calls } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissBtn);
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(screen.getByText(/dismissed/i)).toBeTruthy();
    });
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

describe('EnvVarRequestWidget — terminal states', () => {
  it('renders the submitted summary with names + scope', () => {
    const widget = makeWidget({
      status: 'submitted',
      resolved_at: '2026-05-19T12:34:56.000Z',
      result_meta: { names_submitted: ['HUBSPOT_API_KEY'], scope: 'global' },
    });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByText(/HUBSPOT_API_KEY/i)).toBeTruthy();
    expect(screen.getByText(/saved/i)).toBeTruthy();
    expect(screen.getByText(/global/i)).toBeTruthy();
    expect(screen.getByText(/Update it in User Settings/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('renders submitted summary for values plus used-existing names', () => {
    const widget = makeWidget({
      status: 'submitted',
      resolved_at: '2026-05-19T12:34:56.000Z',
      result_meta: {
        names_submitted: ['STRIPE_SECRET_KEY'],
        names_used_existing: ['HUBSPOT_API_KEY'],
        scope: 'global',
      },
    });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByText(/Saved STRIPE_SECRET_KEY/i)).toBeTruthy();
    expect(screen.getByText(/Used existing HUBSPOT_API_KEY/i)).toBeTruthy();
  });

  it('renders submitted summary for used-existing-only names', () => {
    const widget = makeWidget({
      status: 'submitted',
      resolved_at: '2026-05-19T12:34:56.000Z',
      result_meta: {
        names_submitted: [],
        names_used_existing: ['HUBSPOT_API_KEY'],
        scope: 'global',
      },
    });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByText(/Used existing HUBSPOT_API_KEY/i)).toBeTruthy();
    expect(screen.queryByText(/Saved HUBSPOT_API_KEY/i)).toBeNull();
  });

  it('renders the dismissed summary', () => {
    const widget = makeWidget({ status: 'dismissed' });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByText(/dismissed/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('renders terminal summaries in deterministic name order', () => {
    const widget = makeWidget({
      status: 'dismissed',
      params: {
        names: ['STRIPE_SECRET_KEY', 'HUBSPOT_API_KEY'],
        reason: 'two integrations',
      },
    });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByText('HUBSPOT_API_KEY, STRIPE_SECRET_KEY dismissed')).toBeTruthy();
  });

  it('renders the already_present summary', () => {
    const widget = makeWidget({ status: 'already_present' });
    const { client } = makeStubClient();
    renderWithApp(
      <EnvVarRequestWidget message={makeMessage(widget)} widget={widget} client={client} />
    );
    expect(screen.getByText(/already configured/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
