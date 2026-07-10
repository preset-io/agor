/**
 * GatewayTokenWidget — UI tests.
 *
 * Focus: the admin-gate on the pending form. Setting a channel's tokens is
 * admin-only, but the client check is only a UX nicety — it must FAIL OPEN so a
 * genuine admin is never shown the read-only notice in place of the form:
 *   - admin / owner role  → form renders
 *   - known non-admin     → "An admin must complete token setup" notice
 *   - unknown/loading role → form renders (fail-open; daemon guard is the real
 *     enforcement)
 *
 * Role is resolved from the canonical store row (`userById`) — mirroring
 * App.tsx — NOT the slim auth user, so we mock `@/hooks` + `@/store/agorStore`.
 */

import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable current-user / role, consumed by the mocks below.
let currentUser: { user_id: string } | null = { user_id: 'user-1' };
let currentRole: string | undefined;

vi.mock('@/hooks', () => ({
  useAuth: () => ({ user: currentUser }),
}));

vi.mock('@/store/agorStore', () => ({
  useAgorStore: (selector: (s: unknown) => unknown) =>
    selector({
      userById: new Map(
        currentUser
          ? [[currentUser.user_id, { user_id: currentUser.user_id, role: currentRole }]]
          : []
      ),
    }),
}));

import { _GatewayTokenWidgetForTests } from './GatewayTokenWidget';

const { PendingForm } = _GatewayTokenWidgetForTests;

/** Wrap with Ant Design's App so `useThemedMessage` finds a message instance. */
function renderWithApp(ui: ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

/** Minimal AgorClient stub — the form only needs `service(path).create(body)`. */
function makeStubClient(): AgorClient {
  return {
    service() {
      return {
        async create() {
          return {};
        },
      };
    },
  } as unknown as AgorClient;
}

const PARAMS = {
  gatewayChannelId: 'gc-1',
  channelType: 'slack',
  channelName: 'eng-alerts',
  fields: ['bot_token'],
  reason: 'Enable Slack notifications.',
};

function renderForm() {
  return renderWithApp(<PendingForm widgetId="wid-1" params={PARAMS} client={makeStubClient()} />);
}

const NOTICE = /An admin must complete token setup/i;

describe('GatewayTokenWidget — admin gate (fail-open)', () => {
  beforeEach(() => {
    currentUser = { user_id: 'user-1' };
    currentRole = undefined;
  });

  it('renders the form for an admin role', () => {
    currentRole = 'admin';
    renderForm();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByLabelText(/Value for Bot token/i)).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('shows the Dismiss action for an admin', () => {
    currentRole = 'admin';
    renderForm();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('hides Dismiss while the role is still loading (form fail-open, Dismiss is not)', () => {
    currentRole = undefined;
    renderForm();
    // The form renders fail-open, but the admin-only Dismiss action must not.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('shows no Dismiss for a known non-admin (notice only)', () => {
    currentRole = 'member';
    renderForm();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('renders the form for an owner role', () => {
    currentRole = 'owner';
    renderForm();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('shows the read-only notice for a known non-admin role', () => {
    currentRole = 'member';
    renderForm();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('fails OPEN: renders the form while the role is unknown/loading', () => {
    currentRole = undefined; // store row not hydrated yet
    renderForm();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBODNAKEY\n-----END PRIVATE KEY-----';

const GITHUB_PARAMS = {
  gatewayChannelId: 'gc-2',
  channelType: 'github',
  channelName: 'gh-bot',
  fields: ['private_key'],
  reason: 'Enable GitHub App.',
};

function renderGithubForm() {
  return renderWithApp(
    <PendingForm widgetId="wid-2" params={GITHUB_PARAMS} client={makeStubClient()} />
  );
}

describe('GatewayTokenWidget — secure multi-line (GitHub PEM)', () => {
  beforeEach(() => {
    currentUser = { user_id: 'user-1' };
    currentRole = 'admin';
  });

  it('renders private_key as a textarea for entry, not a masked single-line input', () => {
    renderGithubForm();
    const field = screen.getByLabelText(/Value for Private key/i) as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
  });

  it('collapses to a locked "provided" summary on change (paste) and never re-shows the raw PEM', () => {
    renderGithubForm();
    const field = screen.getByLabelText(/Value for Private key/i) as HTMLTextAreaElement;
    // A change/paste alone collapses the field to the locked summary.
    fireEvent.change(field, { target: { value: PEM } });

    expect(screen.queryByLabelText(/Value for Private key/i)).toBeNull();
    expect(screen.getByText(/Private key provided/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.queryByText(/BEGIN PRIVATE KEY/i)).toBeNull();
  });

  it('Replace clears the value and restores the textarea for re-entry', () => {
    renderGithubForm();
    const field = screen.getByLabelText(/Value for Private key/i) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: PEM } });

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const reopened = screen.getByLabelText(/Value for Private key/i) as HTMLTextAreaElement;
    expect(reopened.tagName).toBe('TEXTAREA');
    expect(reopened.value).toBe('');
  });
});
