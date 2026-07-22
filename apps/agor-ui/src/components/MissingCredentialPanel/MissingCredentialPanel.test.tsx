import type { AgorClient, AuthCheckResult } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialPanel } from './MissingCredentialPanel';

function makeClient(result: Promise<AuthCheckResult> | AuthCheckResult) {
  const create = vi.fn().mockReturnValue(Promise.resolve(result));
  const client = {
    service(name: string) {
      if (name !== 'check-auth') throw new Error(`unexpected service ${name}`);
      return { create };
    },
  } as never as AgorClient;
  return { client, create };
}

function renderPanel(client: AgorClient, onOpenAgenticToolSettings = vi.fn()) {
  return render(
    <AntApp>
      <MissingCredentialPanel
        tool="claude-code"
        client={client}
        onOpenAgenticToolSettings={onOpenAgenticToolSettings}
      />
    </AntApp>
  );
}

describe('MissingCredentialPanel', () => {
  it('fails safe when auth could not be verified', async () => {
    const { client } = makeClient({
      status: 'unknown',
      authenticated: false,
      method: 'none',
    });

    renderPanel(client);

    expect(await screen.findByText(/couldn't verify your Claude Code connection/i)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^Connect Claude Code$/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check Claude Code settings/i })).toBeEnabled();
  });

  it('fails safe when the auth check request fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('network unavailable'));
    const client = {
      service: () => ({ create }),
    } as never as AgorClient;

    renderPanel(client);

    expect(await screen.findByText(/couldn't verify your Claude Code connection/i)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /^Connect Claude Code$/i })
    ).not.toBeInTheDocument();
  });

  it('offers the settings deep-link only after a definitive unauthenticated result', async () => {
    const onOpen = vi.fn();
    const { client } = makeClient({
      status: 'unauthenticated',
      authenticated: false,
      method: 'none',
    });

    renderPanel(client, onOpen);
    fireEvent.click(await screen.findByRole('button', { name: /^Connect Claude Code$/i }));

    expect(onOpen).toHaveBeenCalledWith('claude-code');
  });

  it('renders the key-console link at the 12px helper-text size', async () => {
    const { client } = makeClient({
      status: 'unauthenticated',
      authenticated: false,
      method: 'none',
    });

    renderPanel(client);

    // Ant's Typography.Link applies its own font-size, so the action must carry
    // an explicit inline 12px to match the adjacent helper text.
    const consoleLink = await screen.findByRole('link', {
      name: /Get one from Claude Code's console/i,
    });
    expect(consoleLink).toHaveStyle({ fontSize: '12px' });
  });

  it('deduplicates concurrent checks for the same client and tool', async () => {
    let resolveCheck!: (result: AuthCheckResult) => void;
    const pending = new Promise<AuthCheckResult>((resolve) => {
      resolveCheck = resolve;
    });
    const { client, create } = makeClient(pending);

    render(
      <AntApp>
        <MissingCredentialPanel tool="claude-code" client={client} />
        <MissingCredentialPanel tool="claude-code" client={client} />
      </AntApp>
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    resolveCheck({ status: 'authenticated', authenticated: true, method: 'oauth' });
    expect(await screen.findAllByText(/already connected/i)).toHaveLength(2);
  });
});
