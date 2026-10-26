/**
 * Where an MCP provider sign-in returns.
 *
 * The daemon's OAuth callback does not finish the flow itself. It forwards the
 * provider response here, in the URL fragment, and this page finishes it with
 * the signed-in user's own session through `mcp-servers/oauth-complete`. The
 * daemon accepts that only from the user who started the flow.
 *
 * The fragment is captured at boot (`captureMcpOAuthReturn`), before the auth
 * gate, and cleared from the address immediately, so the one-time values never
 * survive into history, a copied URL, a `Referer`, or a sign-in `return_to`.
 * This page reads the captured response from sessionStorage, which also lets
 * it finish after a sign-in round trip, and removes it when submitting.
 */

import type { AgorClient } from '@agor-live/client';
import { Alert, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
  captureMcpOAuthReturn,
  clearMcpOAuthReturn,
  readMcpOAuthReturn,
} from '../utils/mcpOAuthReturn';
import { ActionPageShell } from './ActionPageShell';

/** How long the success state stays visible before the window tries to close. */
export const MCP_OAUTH_RETURN_CLOSE_DELAY_MS = 2_000;

interface CompletionResult {
  success?: boolean;
  error?: string;
}

type ReturnState = 'completing' | 'succeeded' | 'failed' | 'unreachable' | 'invalid';

interface Props {
  client: AgorClient | null;
}

export function MCPOAuthReturnPage({ client }: Props) {
  // Normally captured at boot; capturing again covers an in-app navigation.
  const [response] = useState(() => {
    captureMcpOAuthReturn();
    return readMcpOAuthReturn();
  });
  const [state, setState] = useState<ReturnState>(response ? 'completing' : 'invalid');
  const [message, setMessage] = useState<string | null>(null);
  // The authorization code is single-use: submit it once per page load, even
  // when the effect re-runs (StrictMode, client reconnect).
  const submitted = useRef(false);

  useEffect(() => {
    if (!client || !response || submitted.current) return;
    submitted.current = true;
    clearMcpOAuthReturn();
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
      // A rejected call (disconnected or unauthenticated socket) says nothing
      // about who started the flow, and its exchange outcome is unknown, so
      // it is never retried automatically.
      .catch(() => setState('unreachable'));
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
    if (state === 'unreachable') {
      return (
        <Alert
          type="error"
          showIcon
          title="The sign-in was not completed"
          description="Couldn't reach Agor. Check the connection status, or start again."
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
