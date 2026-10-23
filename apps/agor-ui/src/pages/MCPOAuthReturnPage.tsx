/**
 * Where an MCP provider sign-in returns.
 *
 * The daemon's OAuth callback does not finish the flow itself. It forwards the
 * provider response here, in the URL fragment, and this page finishes it with
 * the signed-in user's own session through `mcp-servers/oauth-complete`. The
 * daemon accepts that only from the user who started the flow.
 *
 * The fragment is read once and cleared immediately, so the one-time values
 * never survive into history, a copied URL, or a `Referer`.
 */

import type { AgorClient } from '@agor-live/client';
import { Alert, Spin } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionPageShell } from './ActionPageShell';

/** How long the success state stays visible before the window tries to close. */
export const MCP_OAUTH_RETURN_CLOSE_DELAY_MS = 2_000;

interface ProviderResponse {
  state: string;
  code?: string;
  iss?: string;
  error?: string;
}

interface CompletionResult {
  success?: boolean;
  error?: string;
}

type ReturnState = 'completing' | 'succeeded' | 'failed' | 'invalid';

function readProviderResponse(): ProviderResponse | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const state = params.get('state')?.trim();
  const code = params.get('code')?.trim() || undefined;
  const error = params.get('error')?.trim() || undefined;
  if (!state || (!code && !error)) return null;
  const iss = params.get('iss')?.trim() || undefined;
  return { state, ...(code ? { code } : {}), ...(iss ? { iss } : {}), ...(error ? { error } : {}) };
}

interface Props {
  client: AgorClient | null;
}

export function MCPOAuthReturnPage({ client }: Props) {
  const response = useMemo(readProviderResponse, []);
  const [state, setState] = useState<ReturnState>(response ? 'completing' : 'invalid');
  const [message, setMessage] = useState<string | null>(null);
  // The authorization code is single-use: submit it once per page load, even
  // when the effect re-runs (StrictMode, client reconnect).
  const submitted = useRef(false);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`
      );
    }
  }, []);

  useEffect(() => {
    if (!client || !response || submitted.current) return;
    submitted.current = true;
    client
      .service('mcp-servers/oauth-complete')
      .create(response)
      .then((result) => {
        const value = result as CompletionResult;
        if (value?.success) {
          setState('succeeded');
          return;
        }
        setMessage(value?.error ?? null);
        setState('failed');
      })
      .catch(() => setState('failed'));
  }, [client, response]);

  useEffect(() => {
    if (state !== 'succeeded') return;
    const timer = window.setTimeout(() => window.close(), MCP_OAUTH_RETURN_CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const status = (() => {
    if (state === 'completing') return <Spin description="Finishing sign-in…" />;
    if (state === 'succeeded') {
      return (
        <Alert
          type="success"
          showIcon
          title="Connected"
          description="You can close this window and return to Agor."
        />
      );
    }
    if (state === 'invalid') {
      return (
        <Alert
          type="warning"
          showIcon
          title="Nothing to finish here"
          description="This sign-in link is incomplete or was already used. Start the connection again from Agor."
        />
      );
    }
    return (
      <Alert
        type="error"
        showIcon
        title="The sign-in was not completed"
        description={
          message ??
          'Agor could not finish this sign-in. It must be finished by the Agor user who started it. Start the connection again from Agor.'
        }
      />
    );
  })();

  return (
    <ActionPageShell
      titleId="mcp-oauth-return-title"
      title="Connect MCP server"
      subtitle="Finishing the sign-in you started in Agor."
      status={status}
      footnote="Agor finishes a sign-in only for the Agor user who started it."
    />
  );
}
