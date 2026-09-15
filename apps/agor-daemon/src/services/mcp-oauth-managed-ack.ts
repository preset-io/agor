import { randomUUID } from 'node:crypto';
import type { ManagedMCPOAuthClient } from '@agor/core/tools/mcp/managed-oauth-client';
import {
  type MCPManagedOAuthGrantMetadata,
  McpOAuthAckRequestSchema,
  McpOAuthAckResponseSchema,
  type McpOAuthOwner,
  mcpOAuthLengthPrefix,
  mcpOAuthOwnerBytes,
  mcpOAuthSha256,
} from '@agor/core/types';

/** This identifies the committed receipt, not the possibly later broker sequence cursor. */
export function managedOAuthReceiptCommitFence(metadata: MCPManagedOAuthGrantMetadata): string {
  return mcpOAuthSha256(
    mcpOAuthLengthPrefix([
      'agor:mcp-oauth:committed-receipt:v1',
      mcpOAuthSha256(mcpOAuthOwnerBytes(metadata.owner)),
      metadata.receipt_id,
      metadata.operation_id,
      metadata.receipt_claims.next_sequence,
    ])
  );
}

/** Caller must obtain metadata from a completed local commit or committed-only repository read. */
export function createManagedOAuthAcknowledger(input: {
  sender: Pick<ManagedMCPOAuthClient, 'request'>;
  assertOwner(
    owner: McpOAuthOwner,
    budget?: { timeoutMs?: number; signal?: AbortSignal }
  ): void | Promise<void>;
}) {
  return async (
    metadata: MCPManagedOAuthGrantMetadata,
    execution?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      assertCurrent?: () => void | Promise<void>;
    }
  ): Promise<void> => {
    if (execution?.signal?.aborted) throw new Error('Managed ACK stopped');
    await execution?.assertCurrent?.();
    if (execution?.timeoutMs !== undefined && execution.timeoutMs <= 0)
      throw new Error('Managed ACK budget exhausted');
    await input.sender.request({
      operation: 'ack',
      id: metadata.operation_id,
      body: McpOAuthAckRequestSchema.parse({
        protocol_version: 1,
        operation_id: randomUUID(),
        owner: metadata.owner,
        target_operation_id: metadata.operation_id,
        receipt_id: metadata.receipt_id,
        claim: metadata.claim,
        cell_commit_fence: managedOAuthReceiptCommitFence(metadata),
      }),
      schema: McpOAuthAckResponseSchema,
      recovery: true,
      timeoutMs: execution?.timeoutMs,
      assertCurrent: async () => {
        await execution?.assertCurrent?.();
        if (execution?.signal?.aborted) throw new Error('Managed ACK stopped');
        await input.assertOwner(metadata.owner, execution);
        await execution?.assertCurrent?.();
      },
    });
  };
}
