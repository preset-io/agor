import type { AgorClient, MCPServer } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';

/** Policy is a GET/find projection, not part of PATCH or realtime rows. */
export function useSavedMCPOAuthPolicy({
  server,
  client,
  authorityKey,
  open,
}: {
  server: MCPServer | null;
  client: AgorClient | null;
  authorityKey: string | null;
  open: boolean;
}) {
  const guard = useAuthorityOperationGuard(
    open && authorityKey ? [authorityKey, client, server?.mcp_server_id] : null
  );
  const latestRef = useRef(server);
  const [loaded, setLoaded] = useState<MCPServer | null>(null);
  const [failedRow, setFailedRow] = useState<MCPServer | null>(null);
  const [retry, setRetry] = useState(0);
  const observed = useRef<readonly (MCPServer | null)[]>([]);

  // Never regress on an out-of-order PATCH response, GET, or socket replacement.
  // A projection can only fill in a row of the SAME revision, never a newer one.
  const inputs = [server, loaded];
  for (const [index, row] of inputs.entries()) {
    if (row === observed.current[index]) continue;
    const latest = latestRef.current;
    if (
      row &&
      (!latest ||
        (row.config_version ?? 1) > (latest.config_version ?? 1) ||
        ((row.config_version ?? 1) === (latest.config_version ?? 1) &&
          row.oauth_compatibility_policy))
    ) {
      latestRef.current = row;
    }
  }
  observed.current = inputs;
  const latest = latestRef.current;
  const needsPolicy = latest?.auth?.type === 'oauth' && !latest.oauth_compatibility_policy;

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly starts another read without changing the saved row.
  useEffect(() => {
    if (!client || !latest || !needsPolicy || !guard.isCurrent()) return;
    const operation = guard.begin();
    setFailedRow(null);
    void (async () => {
      try {
        const result = await client.service('mcp-servers').get(latest.mcp_server_id);
        if (!operation.isCurrent()) return;
        if (
          result.mcp_server_id !== latest.mcp_server_id ||
          (result.config_version ?? 1) < (latest.config_version ?? 1) ||
          (result.auth?.type === 'oauth' && !result.oauth_compatibility_policy)
        ) {
          throw new Error('Current OAuth policy projection unavailable');
        }
        setLoaded(result);
      } catch {
        // A save may already have committed. Do not report it as failed or
        // substitute the previous policy; retry is an authorized read only.
        if (operation.isCurrent()) setFailedRow(latest);
      }
    })();
    return () => operation.cancel();
  }, [client, guard, latest, needsPolicy, retry]);

  return {
    policyServer: open && authorityKey ? latest : null,
    policyUnavailable: needsPolicy && failedRow === latest,
    retryPolicy: () => setRetry((value) => value + 1),
  };
}
