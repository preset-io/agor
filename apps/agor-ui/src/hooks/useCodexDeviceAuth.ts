import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type CodexDeviceAuthFlowStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface CodexDeviceAuthFlow {
  flowId: string;
  agorUserId: string;
  status: CodexDeviceAuthFlowStatus;
  verificationUri: string | null;
  userCode: string | null;
  codexHome: string;
  executionUnixUser: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface UseCodexDeviceAuthOptions {
  onCompleted?: () => void | Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to start Codex login';
}

const POLL_INTERVAL_MS = 1500;

export function useCodexDeviceAuth(
  client: AgorClient | null,
  options: UseCodexDeviceAuthOptions = {}
) {
  const [flow, setFlow] = useState<CodexDeviceAuthFlow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof window.setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollFlow = useCallback(
    async (flowId: string) => {
      if (!client) {
        stopPolling();
        return;
      }

      try {
        const nextFlow = (await client
          .service('codex-device-auth')
          .get(flowId)) as CodexDeviceAuthFlow | null;

        if (!nextFlow) {
          stopPolling();
          setFlow(null);
          return;
        }

        setFlow(nextFlow);

        if (nextFlow.status === 'pending') {
          return;
        }

        stopPolling();

        if (nextFlow.status === 'completed') {
          await options.onCompleted?.();
        }
      } catch (nextError) {
        stopPolling();
        setError(getErrorMessage(nextError));
      }
    },
    [client, options, stopPolling]
  );

  const startPolling = useCallback(
    (flowId: string) => {
      stopPolling();
      pollRef.current = window.setInterval(() => {
        void pollFlow(flowId);
      }, POLL_INTERVAL_MS);
    },
    [pollFlow, stopPolling]
  );

  const start = useCallback(async () => {
    if (!client) {
      return null;
    }

    try {
      setSubmitting(true);
      const nextFlow = (await client
        .service('codex-device-auth')
        .create({})) as CodexDeviceAuthFlow;
      setFlow(nextFlow);
      setError(null);

      if (nextFlow.status === 'pending') {
        startPolling(nextFlow.flowId);
      } else if (nextFlow.status === 'completed') {
        await options.onCompleted?.();
      }

      return nextFlow;
    } catch (nextError) {
      setError(getErrorMessage(nextError));
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [client, options, startPolling]);

  const cancel = useCallback(async () => {
    if (!client || !flow?.flowId) {
      return null;
    }

    try {
      setSubmitting(true);
      const nextFlow = (await client
        .service('codex-device-auth')
        .remove(flow.flowId)) as CodexDeviceAuthFlow | null;
      stopPolling();
      setFlow(nextFlow);
      setError(null);
      return nextFlow;
    } catch (nextError) {
      setError(getErrorMessage(nextError));
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [client, flow?.flowId, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  return {
    flow,
    submitting,
    error,
    start,
    cancel,
    clearError: () => setError(null),
  };
}
