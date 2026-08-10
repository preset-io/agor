import type { AgorClient, MCPServer } from '@agor-live/client';
import { agorStore } from '@/store/agorStore';

export type MCPOAuthAttemptStatus =
  | 'pending'
  | 'exchanging'
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'expired'
  | 'not_found';

export interface MCPOAuthAttemptResult {
  status: MCPOAuthAttemptStatus;
  mcp_server_id?: string;
  oauth_mode?: 'per_user' | 'shared';
  failure_code?: string;
}

const sleep = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('OAuth status polling was cancelled', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('OAuth status polling was cancelled', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Poll the durable, authenticated attempt resource. Realtime completion is a
 * latency hint only; this refetch is the UI correctness path and also survives
 * callback handling by a different daemon or a missed socket event.
 */
export async function waitForMCPOAuthAttempt(
  client: AgorClient,
  attemptId: string,
  options: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {}
): Promise<MCPOAuthAttemptResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 11 * 60 * 1000);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new DOMException('OAuth status polling was cancelled', 'AbortError');
    }
    const attempt = (await client
      .service('mcp-servers/oauth-attempt-status')
      .get(attemptId)) as MCPOAuthAttemptResult;
    if (attempt.status !== 'pending' && attempt.status !== 'exchanging') return attempt;
    await sleep(options.pollMs ?? 750, options.signal);
  }
  return { status: 'expired', failure_code: 'status_poll_timed_out' };
}

export function oauthAttemptFailureMessage(status: MCPOAuthAttemptStatus): string {
  if (status === 'ambiguous') {
    return 'OAuth exchange outcome is uncertain. Start a new sign-in; the previous authorization code will not be replayed.';
  }
  if (status === 'expired') return 'OAuth sign-in expired. Start a new sign-in.';
  return 'OAuth sign-in did not complete. Start a new sign-in.';
}

/** Refetch and atomically apply both durable OAuth UI authorities. */
export async function refetchMCPOAuthDurableState(
  client: AgorClient,
  mcpServerId: string
): Promise<void> {
  const [status, fresh] = await Promise.all([
    client.service('mcp-servers/oauth-status').find(),
    client.service('mcp-servers').get(mcpServerId),
  ]);
  const ids = (status as { authenticated_server_ids?: string[] })?.authenticated_server_ids ?? [];
  const server = fresh as MCPServer;
  agorStore.getState().applyMaps((prev) => {
    const mcpServerById = new Map(prev.mcpServerById);
    mcpServerById.set(server.mcp_server_id, server);
    return {
      ...prev,
      userAuthenticatedMcpServerIds: new Set(ids),
      mcpServerById,
    };
  });
}
