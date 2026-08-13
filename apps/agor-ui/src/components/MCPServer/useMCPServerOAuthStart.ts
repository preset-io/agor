import type {
  MCPOAuthDCRDiagnostic,
  MCPOAuthStartFailure,
  MCPOAuthStartFailureKind,
} from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  oauthAttemptFailureMessage,
  refetchMCPOAuthDurableState,
  waitForMCPOAuthAttempt,
} from '@/utils/mcpOAuthAttempt';

export interface MCPServerOAuthFailure {
  kind: MCPOAuthStartFailureKind;
  message: string;
  diagnostic?: MCPOAuthDCRDiagnostic;
}

interface OAuthStartSuccess {
  success: true;
  authorizationUrl: string;
  attempt_id: string;
  state?: string;
}

interface OAuthConfigurationResult {
  success: boolean;
  redirect_uri?: string;
  error?: string;
}

interface UseMCPServerOAuthStartOptions {
  client: AgorClient | null;
  enabled: boolean;
  onPrepareOAuthStart: () => Promise<string | null>;
  onOAuthSucceeded?: () => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
  showSuccess: (message: string) => void;
}

export function useMCPServerOAuthStart({
  client,
  enabled,
  onPrepareOAuthStart,
  onOAuthSucceeded,
  showError,
  showInfo,
  showSuccess,
}: UseMCPServerOAuthStartOptions) {
  const [startingOAuthFlow, setStartingOAuthFlow] = useState(false);
  const [oauthFailure, setOauthFailure] = useState<MCPServerOAuthFailure | null>(null);
  const [oauthCallbackModalVisible, setOauthCallbackModalVisible] = useState(false);
  const [oauthRedirectUri, setOauthRedirectUri] = useState<string | null>(null);
  const [oauthRedirectUriError, setOauthRedirectUriError] = useState<string | null>(null);
  const oauthStartInFlightRef = useRef(false);
  const oauthCompletedCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      oauthCompletedCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!client || !enabled) {
      setOauthRedirectUri(null);
      setOauthRedirectUriError(null);
      return;
    }

    let active = true;
    void client
      .service('mcp-servers/oauth-configuration')
      .find()
      .then((result) => {
        if (!active) return;
        const configuration = result as unknown as OAuthConfigurationResult;
        setOauthRedirectUri(configuration.redirect_uri ?? null);
        setOauthRedirectUriError(
          configuration.success ? null : configuration.error || 'OAuth redirect URL is unavailable.'
        );
      })
      .catch((error) => {
        if (!active) return;
        setOauthRedirectUri(null);
        setOauthRedirectUriError(
          error instanceof Error ? error.message : 'OAuth redirect URL is unavailable.'
        );
      });

    return () => {
      active = false;
    };
  }, [client, enabled]);

  const clearOAuthFailure = useCallback(() => setOauthFailure(null), []);

  const cancelOAuthWait = useCallback(() => {
    setOauthCallbackModalVisible(false);
    oauthCompletedCleanupRef.current?.();
  }, []);

  const handleStartOAuthFlow = useCallback(async () => {
    if (oauthStartInFlightRef.current) return;
    if (!client) {
      showError('Client not available');
      return;
    }

    oauthStartInFlightRef.current = true;
    setStartingOAuthFlow(true);
    setOauthFailure(null);

    try {
      const targetServerId = await onPrepareOAuthStart();
      if (!targetServerId) return;

      showInfo('Starting OAuth authentication flow...');
      const data = (await client.service('mcp-servers/oauth-start').create({
        mcp_server_id: targetServerId,
      })) as OAuthStartSuccess | MCPOAuthStartFailure;

      if (data.success && data.authorizationUrl && data.attempt_id) {
        window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
        setOauthCallbackModalVisible(true);
        showInfo('Authenticating... complete sign-in in the new tab.');

        const controller = new AbortController();
        const cleanup = () => {
          controller.abort();
          oauthCompletedCleanupRef.current = null;
        };
        oauthCompletedCleanupRef.current?.();
        oauthCompletedCleanupRef.current = cleanup;
        void waitForMCPOAuthAttempt(client, data.attempt_id, { signal: controller.signal })
          .then(async (attempt) => {
            if (attempt.status === 'succeeded') {
              try {
                await refetchMCPOAuthDurableState(client, targetServerId);
              } catch {
                console.warn('[OAuth] Durable completion refetch failed');
              }
              showSuccess('OAuth authentication successful!');
              setOauthCallbackModalVisible(false);
              setOauthFailure(null);
              onOAuthSucceeded?.();
            } else {
              showError(oauthAttemptFailureMessage(attempt.status));
              setOauthCallbackModalVisible(false);
            }
          })
          .catch((error) => {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            showError('Could not confirm OAuth status. Check the connection and try again.');
          })
          .finally(() => {
            if (!controller.signal.aborted) cleanup();
          });
      } else if (!data.success) {
        setOauthFailure({
          kind: data.kind ?? (data.diagnostic ? 'dcr' : 'oauth'),
          message: data.error || 'Failed to start OAuth flow',
          diagnostic: data.diagnostic,
        });
        if (data.redirect_uri) {
          setOauthRedirectUri(data.redirect_uri);
          setOauthRedirectUriError(null);
        }
      } else {
        setOauthFailure({ kind: 'oauth', message: 'Failed to start OAuth flow' });
      }
    } catch (error) {
      setOauthFailure({
        kind: 'oauth',
        message: `OAuth flow error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      oauthStartInFlightRef.current = false;
      setStartingOAuthFlow(false);
    }
  }, [client, onOAuthSucceeded, onPrepareOAuthStart, showError, showInfo, showSuccess]);

  return {
    cancelOAuthWait,
    clearOAuthFailure,
    handleStartOAuthFlow,
    oauthCallbackModalVisible,
    oauthFailure,
    oauthRedirectUri,
    oauthRedirectUriError,
    startingOAuthFlow,
  };
}
