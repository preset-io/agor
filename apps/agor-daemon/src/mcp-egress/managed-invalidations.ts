import { randomUUID } from 'node:crypto';
import {
  MCP_OAUTH_LIMITS,
  type MCPManagedOAuthInvalidationPage,
  type MCPManagedOAuthInvalidationRead,
  McpOAuthInvalidationRequestSchema,
  McpOAuthInvalidationResponseSchema,
} from '@agor/core/types';
import { ManagedUseAuthorizationError } from './managed-authorization.js';

/**
 * Wire-to-store reconciliation. Persistence callbacks are trusted DB adapters
 * bound to the authenticated cell/incarnation; none accept a browser selector.
 * Invalidations are monotonic tombstones: a snapshot never deletes newer known
 * evidence. No cursor is acknowledged before its invalidations are durable.
 */
export async function synchronizeManagedInvalidations(options: {
  recoveryIncarnation: string;
  signal: AbortSignal;
  request: (
    body: ReturnType<typeof McpOAuthInvalidationRequestSchema.parse>,
    signal: AbortSignal
  ) => Promise<unknown>;
  readCheckpoint: () => Promise<Pick<MCPManagedOAuthInvalidationRead, 'status' | 'cursor'>>;
  /** Under one DB transaction, compare the cursor and mark snapshot-required. */
  requireSnapshot: (expectedCursor: string | null) => Promise<boolean>;
  /** One transaction commits tenant-filtered tombstones, whole-page evidence, status and cursor CAS. */
  applyPage: (
    expectedCursor: string | null,
    page: MCPManagedOAuthInvalidationPage,
    options: { snapshot: boolean }
  ) => Promise<boolean>;
}): Promise<void> {
  const checkpoint = await options.readCheckpoint();
  let durableCursor = checkpoint.cursor;
  let snapshot = checkpoint.status !== 'ready' || durableCursor === null;
  if (snapshot) {
    // Restart a partial snapshot from its beginning; durable known tombstones
    // survive, and no reader may mistake staging for complete authority.
    if (!(await options.requireSnapshot(durableCursor)))
      throw new ManagedUseAuthorizationError('managed_authority_unavailable');
    durableCursor = null;
  }
  let scanCursor = durableCursor;
  // Overall I/O deadline is owned by the poller/worker transport; this also
  // bounds malicious/cyclic pagination independently of timer scheduling.
  for (let pages = 0; pages < 100; pages++) {
    if (options.signal.aborted)
      throw new ManagedUseAuthorizationError('managed_authority_unavailable');
    const request = McpOAuthInvalidationRequestSchema.parse({
      protocol_version: 1,
      operation_id: randomUUID(),
      recovery_incarnation: options.recoveryIncarnation,
      cursor: scanCursor,
      snapshot,
      limit: MCP_OAUTH_LIMITS.invalidation_page,
    });
    const page = McpOAuthInvalidationResponseSchema.parse(
      await options.request(request, options.signal)
    );
    if (options.signal.aborted || page.recovery_incarnation !== options.recoveryIncarnation) {
      throw new ManagedUseAuthorizationError('managed_authority_unavailable');
    }
    if (page.snapshot_required) {
      if (snapshot || page.items.length || page.snapshot_complete)
        throw new ManagedUseAuthorizationError('managed_authority_invalid');
      if (!(await options.applyPage(durableCursor, page, { snapshot: false })))
        throw new ManagedUseAuthorizationError('managed_authority_unavailable');
      durableCursor = null;
      snapshot = true;
      scanCursor = null;
      continue;
    }
    const prior = scanCursor === null ? -1n : BigInt(scanCursor);
    if (
      BigInt(page.next_cursor) < prior ||
      (!page.snapshot_complete && BigInt(page.next_cursor) <= prior)
    ) {
      throw new ManagedUseAuthorizationError('managed_authority_invalid');
    }
    let itemCursor = prior;
    for (const item of page.items) {
      if (
        item.recovery_incarnation !== options.recoveryIncarnation ||
        BigInt(item.cursor) <= itemCursor ||
        BigInt(item.cursor) > BigInt(page.next_cursor)
      ) {
        throw new ManagedUseAuthorizationError('managed_authority_invalid');
      }
      itemCursor = BigInt(item.cursor);
    }
    // The authenticated cell stream legitimately contains other workspaces.
    // Every tenant independently reads every page from its own checkpoint;
    // its RLS-bound repository filters items but commits the WHOLE page digest.
    if (!(await options.applyPage(durableCursor, page, { snapshot }))) {
      throw new ManagedUseAuthorizationError('managed_authority_unavailable');
    }
    durableCursor = page.next_cursor;
    if (options.signal.aborted)
      throw new ManagedUseAuthorizationError('managed_authority_unavailable');
    if (page.snapshot_complete) return;
    scanCursor = page.next_cursor;
  }
  throw new ManagedUseAuthorizationError('managed_authority_unavailable');
}
