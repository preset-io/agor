import { randomUUID } from 'node:crypto';
import {
  MCP_OAUTH_LIMITS,
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
  allowedWorkspaces: ReadonlySet<string>;
  signal: AbortSignal;
  request: (
    body: ReturnType<typeof McpOAuthInvalidationRequestSchema.parse>,
    signal: AbortSignal
  ) => Promise<unknown>;
  readCursor: () => Promise<string | null>;
  persistInvalidations: (
    items: ReturnType<typeof McpOAuthInvalidationResponseSchema.parse>['items']
  ) => Promise<void>;
  /** Atomic compare-and-set; false means another replica changed this cursor. */
  advanceCursor: (expected: string | null, next: string) => Promise<boolean>;
}): Promise<void> {
  let durableCursor = await options.readCursor();
  let scanCursor = durableCursor;
  let snapshot = durableCursor === null;
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
        !options.allowedWorkspaces.has(item.workspace_id) ||
        item.recovery_incarnation !== options.recoveryIncarnation ||
        BigInt(item.cursor) <= itemCursor ||
        BigInt(item.cursor) > BigInt(page.next_cursor)
      ) {
        throw new ManagedUseAuthorizationError('managed_authority_invalid');
      }
      itemCursor = BigInt(item.cursor);
    }
    await options.persistInvalidations(page.items);
    if (options.signal.aborted)
      throw new ManagedUseAuthorizationError('managed_authority_unavailable');
    // A partial snapshot may durably add denials, but cannot claim that the gap
    // is repaired. Restart repeats the full snapshot; it does not trust RAM.
    if (!snapshot || page.snapshot_complete) {
      if (
        BigInt(page.next_cursor) < BigInt(durableCursor ?? '0') ||
        !(await options.advanceCursor(durableCursor, page.next_cursor))
      ) {
        throw new ManagedUseAuthorizationError('managed_authority_unavailable');
      }
      durableCursor = page.next_cursor;
    }
    if (page.snapshot_complete) return;
    scanCursor = page.next_cursor;
  }
  throw new ManagedUseAuthorizationError('managed_authority_unavailable');
}
