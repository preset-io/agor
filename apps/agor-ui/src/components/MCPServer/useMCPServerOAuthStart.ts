import type { MCPOAuthDCRDiagnostic, MCPOAuthStartFailure } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  oauthAttemptFailureMessage,
  refetchMCPOAuthDurableState,
  waitForMCPOAuthAttempt,
} from '@/utils/mcpOAuthAttempt';

export interface MCPServerOAuthFailure {
  message: string;
  diagnostic?: MCPOAuthDCRDiagnostic;
  redirectUri?: string;
}

interface OAuthStartSuccess {
  success: true;
  authorizationUrl: string;
  attempt_id: string;
}

interface UseMCPServerOAuthStartOptions {
  client: AgorClient | null;
  onPrepareOAuthStart: () => Promise<string | null>;
  onOAuthSucceeded?: () => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
  showSuccess: (message: string) => void;
}

export function useMCPServerOAuthStart({
  client,
  onPrepareOAuthStart,
  onOAuthSucceeded,
  showError,
  showInfo,
  showSuccess,
}: UseMCPServerOAuthStartOptions) {
  const [startingOAuthFlow, setStartingOAuthFlow] = useState(false);
  const [oauthFailure, setOauthFailure] = useState<MCPServerOAuthFailure | null>(null);
  const [oauthCallbackModalVisible, setOauthCallbackModalVisible] = useState(false);
  const oauthStartInFlightRef = useRef(false);
  const oauthCompletedCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      oauthCompletedCleanupRef.current?.();
    };
  }, []);

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
          message: data.error || 'Failed to start OAuth flow',
          diagnostic: data.diagnostic,
          redirectUri: data.redirect_uri,
        });
      } else {
        setOauthFailure({ message: 'Failed to start OAuth flow' });
      }
    } catch (error) {
      setOauthFailure({
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
    startingOAuthFlow,
  };
}
