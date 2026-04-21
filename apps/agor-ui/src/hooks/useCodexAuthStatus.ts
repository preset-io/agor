import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';

export type CodexAuthStatusKind =
  | 'using_api_key'
  | 'signed_in_with_chatgpt'
  | 'not_signed_in'
  | 'unknown';

export interface CodexAuthStatus {
  status: CodexAuthStatusKind;
  label: string;
  description: string;
  warnings: string[];
  guidance: string[];
  codexHome: string;
  apiKeySource?: 'user' | 'config' | 'env';
  credentialStore: string;
  unixUserMode: string;
  executionUnixUser: string | null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load Codex auth status';
}

export function useCodexAuthStatus(client: AgorClient | null) {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) {
      setStatus(null);
      setLoading(false);
      return null;
    }

    try {
      setLoading(true);
      const nextStatus = (await client
        .service('codex-auth-status')
        .get('current')) as CodexAuthStatus;
      setStatus(nextStatus);
      setError(null);
      return nextStatus;
    } catch (nextError) {
      setError(getErrorMessage(nextError));
      return null;
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    loading,
    error,
    refresh,
    clearError: () => setError(null),
  };
}
