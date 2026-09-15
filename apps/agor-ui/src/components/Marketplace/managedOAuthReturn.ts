import {
  type MCPManagedOAuthReturnRequest,
  type MCPManagedOAuthReturnResult,
  McpOAuthIdSchema,
  McpOAuthOpaqueSchema,
} from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { refetchMCPOAuthDurableState, waitForMCPOAuthAttempt } from '../../utils/mcpOAuthAttempt';

// This is browser correlation only, never credential or backend authority.
export const MANAGED_POPUP_FLOW_KEY = 'agor-managed-mcp-popup-v1';
export interface ManagedPopupFlow {
  nonce: string;
  userId: string;
  serverId: string;
  attemptId: string;
  transactionId: string;
  createdAt: number;
}
const invalid = () =>
  new Error('This sign-in window cannot be verified. Start sign-in again from My Servers.');
let captured: { ticket: string; transactionId: string } | null = null;

/** Called by the entrypoint before rendering/authentication/network effects. */
export function captureManagedOAuthReturn(): void {
  if (!/^\/(?:ui\/)?mcp-oauth\/complete\/?$/.test(window.location.pathname)) return;
  const fragment = window.location.hash;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  captured = null;
  const params = new URLSearchParams(fragment.slice(1));
  if (
    params.size !== 2 ||
    params.getAll('ticket').length !== 1 ||
    params.getAll('transaction_id').length !== 1
  )
    return;
  const ticket = params.get('ticket');
  const transactionId = params.get('transaction_id');
  if (
    !ticket ||
    !McpOAuthOpaqueSchema.safeParse(ticket).success ||
    !transactionId ||
    !McpOAuthIdSchema.safeParse(transactionId).success
  )
    return;
  captured = { ticket, transactionId };
}

export function consumeManagedOAuthReturn(userId: string): {
  flow: ManagedPopupFlow;
  ticket: string;
} {
  const returned = captured;
  captured = null;
  const raw = sessionStorage.getItem(MANAGED_POPUP_FLOW_KEY);
  sessionStorage.removeItem(MANAGED_POPUP_FLOW_KEY);
  if (!returned || !raw) throw invalid();
  let flow: ManagedPopupFlow;
  try {
    flow = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !flow ||
    flow.userId !== userId ||
    flow.transactionId !== returned.transactionId ||
    typeof flow.nonce !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(flow.nonce) ||
    typeof flow.serverId !== 'string' ||
    !flow.serverId ||
    typeof flow.attemptId !== 'string' ||
    !flow.attemptId ||
    !Number.isFinite(flow.createdAt) ||
    Date.now() < flow.createdAt ||
    Date.now() - flow.createdAt > 15 * 60_000
  )
    throw invalid();
  return { flow, ticket: returned.ticket };
}

/** Ticket acceptance is not completion; both durable authorities must agree. */
export async function completeManagedOAuthReturn(
  client: AgorClient,
  returned: { flow: ManagedPopupFlow; ticket: string },
  isCurrent: () => boolean,
  signal: AbortSignal
): Promise<void> {
  if (!isCurrent() || signal.aborted) throw invalid();
  const { flow } = returned;
  const request: MCPManagedOAuthReturnRequest = {
    transaction_id: flow.transactionId,
    ticket: returned.ticket,
    client_nonce: flow.nonce,
  };
  const result = (await client
    .service('mcp-servers/oauth-managed-return')
    .create(request)) as MCPManagedOAuthReturnResult;
  if (
    !isCurrent() ||
    signal.aborted ||
    result.accepted !== true ||
    String(result.attempt_id) !== flow.attemptId
  )
    throw invalid();
  const attempt = await waitForMCPOAuthAttempt(client, flow.attemptId, { signal });
  if (
    !isCurrent() ||
    signal.aborted ||
    attempt.status !== 'succeeded' ||
    String(attempt.mcp_server_id) !== flow.serverId
  )
    throw invalid();
  if (
    !(await refetchMCPOAuthDurableState(client, flow.serverId, isCurrent)) ||
    !isCurrent() ||
    signal.aborted
  )
    throw invalid();
}
