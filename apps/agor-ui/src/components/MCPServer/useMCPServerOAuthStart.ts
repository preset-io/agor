import type { MCPAuthRecovery, MCPOAuthStartFailure } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import {
  describeActionError,
  notConnectedMessage,
  withConnectionErrorDetail,
} from '@/utils/connectionErrors';
import {
  oauthAttemptFailureMessage,
  refetchMCPOAuthDurableState,
  waitForMCPOAuthAttempt,
} from '@/utils/mcpOAuthAttempt';

export interface MCPServerOAuthFailure {
  message: string;
  recovery?: MCPAuthRecovery;
  redirectUri?: string;
  /** Raw error, shown under Details. */
  detail?: string;
  /** An unfinished sign-in needs the user rather than signalling a fault. */
  severity?: 'warning';
}

const START_ACTION = 'start sign-in';

interface OAuthStartSuccess {
  success: true;
  authorizationUrl: string;
  attempt_id: string;
}

interface UseMCPServerOAuthStartOptions {
  client: AgorClient | null;
  /** Opaque identity + role + successful-auth generation, null while disconnected. */
  authorityKey: string | null;
  onPrepareOAuthStart: () => Promise<string | null>;
  onOAuthAttemptStarted?: (attemptId: string, serverId: string) => void;
  onOAuthSucceeded?: () => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
  showSuccess: (message: string) => void;
  /** Falls back to `showError`. */
  showWarning?: (message: string) => void;
  /** The caller renders `oauthFailure`, so an unfinished sign-in needs no toast as well. */
  rendersFailureInline?: boolean;
  /** Current authority to persist/start this OAuth configuration. */
  startAllowed?: boolean;
}

export function useMCPServerOAuthStart({
  client,
  authorityKey,
  onPrepareOAuthStart,
  onOAuthAttemptStarted,
  onOAuthSucceeded,
  showError,
  showInfo,
  showSuccess,
  showWarning = showError,
  rendersFailureInline = false,
  startAllowed = true,
}: UseMCPServerOAuthStartOptions) {
  const [startingOAuthFlow, setStartingOAuthFlow] = useState(false);
  const [oauthFailure, setOauthFailure] = useState<MCPServerOAuthFailure | null>(null);
  const [oauthCallbackModalVisible, setOauthCallbackModalVisible] = useState(false);
  const oauthStartInFlightRef = useRef(false);
  const oauthStartGenerationRef = useRef(0);
  const oauthCompletedCleanupRef = useRef<(() => void) | null>(null);
  const startAllowedRef = useRef(startAllowed);
  startAllowedRef.current = startAllowed;
  const authorityKeyRef = useRef(authorityKey);
  authorityKeyRef.current = authorityKey;
  const clientRef = useRef(client);
  clientRef.current = client;
  const operationGuard = useAuthorityOperationGuard(
    authorityKey && startAllowed ? [authorityKey, client, startAllowed] : null
  );

  const invalidateOAuthStart = useCallback(() => {
    oauthStartGenerationRef.current += 1;
    oauthStartInFlightRef.current = false;
    oauthCompletedCleanupRef.current?.();
  }, []);

  // A long-lived socket client can survive identity, role, and token
  // replacement. Abort the previous wait on any authority/client transition;
  // render-time refs below close the window before this passive cleanup runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: authority/client changes intentionally run cleanup
  useEffect(
    () => () => {
      invalidateOAuthStart();
    },
    [authorityKey, client, invalidateOAuthStart]
  );

  useEffect(() => {
    if (!startAllowed || !authorityKey || !client) {
      invalidateOAuthStart();
      setOauthCallbackModalVisible(false);
      setStartingOAuthFlow(false);
    }
  }, [authorityKey, client, invalidateOAuthStart, startAllowed]);

  const clearOAuthFailure = useCallback(() => setOauthFailure(null), []);

  const cancelOAuthWait = useCallback(() => {
    invalidateOAuthStart();
    setOauthCallbackModalVisible(false);
    setStartingOAuthFlow(false);
  }, [invalidateOAuthStart]);

  const handleStartOAuthFlow = useCallback(async () => {
    if (oauthStartInFlightRef.current) return;
    if (!client) {
      showError(notConnectedMessage(START_ACTION));
      return;
    }
    // A blocked start is shown by the caller's disabled sign-in control and its tooltip.
    const startAuthorityKey = authorityKeyRef.current;
    if (!startAllowedRef.current || !startAuthorityKey) return;

    const startClient = client;
    const authorityOperation = operationGuard.begin();
    if (!authorityOperation.isCurrent()) return;
    oauthStartInFlightRef.current = true;
    const startGeneration = ++oauthStartGenerationRef.current;
    const isCurrentStart = () =>
      oauthStartGenerationRef.current === startGeneration &&
      authorityOperation.isCurrent() &&
      startAllowedRef.current &&
      authorityKeyRef.current === startAuthorityKey &&
      clientRef.current === startClient;
    setStartingOAuthFlow(true);
    setOauthFailure(null);
    // Callers that don't render `oauthFailure` still need to see why sign-in didn't start.
    const failStart = (failure: MCPServerOAuthFailure) => {
      if (!rendersFailureInline) showError(failure.message);
      setOauthFailure(failure);
    };

    try {
      const targetServerId = await onPrepareOAuthStart();
      if (!isCurrentStart()) return;
      if (!targetServerId || !startAllowedRef.current) return;

      showInfo('Starting sign-in…');
      if (!isCurrentStart()) return;
      const data = (await client.service('mcp-servers/oauth-start').create({
        mcp_server_id: targetServerId,
      })) as OAuthStartSuccess | MCPOAuthStartFailure;
      if (!isCurrentStart()) return;

      if (data.success && data.authorizationUrl && data.attempt_id) {
        if (!isCurrentStart()) return;
        try {
          onOAuthAttemptStarted?.(data.attempt_id, targetServerId);
        } catch {
          // Attempt fencing is presentation-only. The durable OAuth attempt
          // remains authoritative and must still open for recovery.
        }
        if (!isCurrentStart()) return;
        window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
        setOauthCallbackModalVisible(true);
        showInfo('Finish signing in in the new tab.');

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
                await refetchMCPOAuthDurableState(client, targetServerId, isCurrentStart);
                if (!isCurrentStart()) return;
              } catch {
                if (isCurrentStart()) console.warn('[OAuth] Durable completion refetch failed');
              }
              if (!isCurrentStart()) return;
              showSuccess('Signed in.');
              setOauthCallbackModalVisible(false);
              setOauthFailure(null);
              onOAuthSucceeded?.();
            } else {
              if (!isCurrentStart()) return;
              const message =
                attempt.recovery?.message ?? oauthAttemptFailureMessage(attempt.status);
              if (!rendersFailureInline) showError(message);
              setOauthFailure({
                message,
                recovery: attempt.recovery,
                redirectUri: attempt.recovery?.redirect_uri,
                ...(attempt.recovery ? {} : { severity: 'warning' as const }),
              });
              setOauthCallbackModalVisible(false);
            }
          })
          .catch((error) => {
            if (!isCurrentStart()) return;
            if (error instanceof DOMException && error.name === 'AbortError') return;
            // The attempt may still have succeeded, so this is not a failed sign-in.
            showWarning(
              withConnectionErrorDetail(
                "Couldn't confirm the sign-in. Check this server's status before you sign in again.",
                error
              )
            );
          })
          .finally(() => {
            if (!controller.signal.aborted && isCurrentStart()) cleanup();
          });
      } else if (!data.success) {
        if (!isCurrentStart()) return;
        failStart({
          message: data.error || "Couldn't start sign-in.",
          recovery: data.recovery,
          redirectUri: data.recovery?.redirect_uri ?? data.redirect_uri,
        });
      } else {
        if (!isCurrentStart()) return;
        failStart({ message: "Couldn't start sign-in." });
      }
    } catch (error) {
      if (isCurrentStart()) {
        // A retry starts a fresh attempt, so the connection copy may invite one.
        const { message, raw } = describeActionError(START_ACTION, error, { idempotent: true });
        failStart({
          message:
            message === `Couldn't ${START_ACTION}.`
              ? `${message} If it keeps happening, ask an administrator.`
              : message,
          ...(raw ? { detail: raw } : {}),
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
    onOAuthAttemptStarted,
    onPrepareOAuthStart,
    operationGuard,
    showError,
    showInfo,
    showSuccess,
    showWarning,
    rendersFailureInline,
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
