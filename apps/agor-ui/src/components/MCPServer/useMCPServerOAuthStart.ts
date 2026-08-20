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
  /** Current authority to persist/start this OAuth configuration. */
  startAllowed?: boolean;
  startBlockedReason?: string;
}

export function useMCPServerOAuthStart({
  client,
  onPrepareOAuthStart,
  onOAuthSucceeded,
  showError,
  showInfo,
  showSuccess,
  startAllowed = true,
  startBlockedReason = 'You can no longer change this MCP server.',
}: UseMCPServerOAuthStartOptions) {
  const [startingOAuthFlow, setStartingOAuthFlow] = useState(false);
  const [oauthFailure, setOauthFailure] = useState<MCPServerOAuthFailure | null>(null);
  const [oauthCallbackModalVisible, setOauthCallbackModalVisible] = useState(false);
  const oauthStartInFlightRef = useRef(false);
  const oauthStartGenerationRef = useRef(0);
  const oauthCompletedCleanupRef = useRef<(() => void) | null>(null);
  const startAllowedRef = useRef(startAllowed);
  startAllowedRef.current = startAllowed;

  const invalidateOAuthStart = useCallback(() => {
    oauthStartGenerationRef.current += 1;
    oauthStartInFlightRef.current = false;
    oauthCompletedCleanupRef.current?.();
  }, []);

  useEffect(() => {
    return invalidateOAuthStart;
  }, [invalidateOAuthStart]);

  useEffect(() => {
    if (!startAllowed) {
      invalidateOAuthStart();
      setOauthCallbackModalVisible(false);
      setStartingOAuthFlow(false);
    }
  }, [invalidateOAuthStart, startAllowed]);

  const clearOAuthFailure = useCallback(() => setOauthFailure(null), []);

  const cancelOAuthWait = useCallback(() => {
    invalidateOAuthStart();
    setOauthCallbackModalVisible(false);
    setStartingOAuthFlow(false);
  }, [invalidateOAuthStart]);

  const handleStartOAuthFlow = useCallback(async () => {
    if (oauthStartInFlightRef.current) return;
    if (!client) {
      showError('Client not available');
      return;
    }
    if (!startAllowedRef.current) {
      showError(startBlockedReason);
      return;
    }

    oauthStartInFlightRef.current = true;
    const startGeneration = ++oauthStartGenerationRef.current;
    const isCurrentStart = () => oauthStartGenerationRef.current === startGeneration;
    setStartingOAuthFlow(true);
    setOauthFailure(null);

    try {
      const targetServerId = await onPrepareOAuthStart();
      if (!isCurrentStart()) return;
      if (!targetServerId) return;
      if (!startAllowedRef.current) {
        showError(startBlockedReason);
        return;
      }

      showInfo('Starting OAuth authentication flow...');
      if (!isCurrentStart()) return;
      const data = (await client.service('mcp-servers/oauth-start').create({
        mcp_server_id: targetServerId,
      })) as OAuthStartSuccess | MCPOAuthStartFailure;
      if (!isCurrentStart()) return;

      if (data.success && data.authorizationUrl && data.attempt_id) {
        if (!isCurrentStart()) return;
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
            if (!isCurrentStart()) return;
            if (attempt.status === 'succeeded') {
              try {
                await refetchMCPOAuthDurableState(client, targetServerId);
                if (!isCurrentStart()) return;
              } catch {
                if (isCurrentStart()) console.warn('[OAuth] Durable completion refetch failed');
              }
              if (!isCurrentStart()) return;
              showSuccess('OAuth authentication successful!');
              setOauthCallbackModalVisible(false);
              setOauthFailure(null);
              onOAuthSucceeded?.();
            } else {
              if (!isCurrentStart()) return;
              showError(oauthAttemptFailureMessage(attempt.status));
              setOauthCallbackModalVisible(false);
            }
          })
          .catch((error) => {
            if (!isCurrentStart()) return;
            if (error instanceof DOMException && error.name === 'AbortError') return;
            showError('Could not confirm OAuth status. Check the connection and try again.');
          })
          .finally(() => {
            if (!controller.signal.aborted && isCurrentStart()) cleanup();
          });
      } else if (!data.success) {
        if (!isCurrentStart()) return;
        setOauthFailure({
          message: data.error || 'Failed to start OAuth flow',
          diagnostic: data.diagnostic,
          redirectUri: data.redirect_uri,
        });
      } else {
        if (!isCurrentStart()) return;
        setOauthFailure({ message: 'Failed to start OAuth flow' });
      }
    } catch (error) {
      if (isCurrentStart()) {
        setOauthFailure({
          message: `OAuth flow error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      if (isCurrentStart()) {
        oauthStartInFlightRef.current = false;
        setStartingOAuthFlow(false);
      }
    }
  }, [
    client,
    onOAuthSucceeded,
    onPrepareOAuthStart,
    showError,
    showInfo,
    showSuccess,
    startBlockedReason,
  ]);

  return {
    cancelOAuthWait,
    clearOAuthFailure,
    handleStartOAuthFlow,
    oauthCallbackModalVisible,
    oauthFailure,
    startingOAuthFlow,
  };
}
