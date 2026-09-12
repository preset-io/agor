import { z } from 'zod';

/** Explicit opt-in for the managed, awaited tool boundary. Native SDK adapters remain gated. */
export const BranchWorkspaceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    native_adapter: z.literal('claude_workspace').optional(),
    backend: z.literal('local_replicated').default('local_replicated'),
    tool_boundary_sync: z.literal(true).default(true),
    local_root: z.string().startsWith('/').default('/var/lib/agor'),
    clone: z.enum(['reflink', 'copy']).default('reflink'),
    checkpoint_idle_seconds: z.number().int().positive().default(300),
    maximum_local_bytes: z
      .number()
      .int()
      .positive()
      .default(20 * 1024 ** 3),
    maximum_local_inodes: z.number().int().positive().default(250000),
    minimum_free_bytes: z
      .number()
      .int()
      .nonnegative()
      .default(10 * 1024 ** 3),
    minimum_free_inodes: z.number().int().nonnegative().default(100000),
    maximum_active_tools: z.number().int().positive().max(64).default(8),
    maximum_receipts: z.number().int().positive().default(10000),
    lease_seconds: z.number().int().min(10).default(120),
    tool_lease_seconds: z.number().int().min(1).default(600),
    conflict_policy: z.literal('reject').default('reject'),
    exclude: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).default([]),
    tenant_ids: z.array(z.string().min(1)).default([]),
    branch_ids: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type BranchWorkspaceConfig = z.input<typeof BranchWorkspaceConfigSchema>;
export function resolveBranchWorkspaceConfig(input?: BranchWorkspaceConfig) {
  return BranchWorkspaceConfigSchema.parse(input ?? {});
}
export function usesReplicatedWorkspace(
  config: BranchWorkspaceConfig | undefined,
  tenantId: string,
  branchId: string
): boolean {
  const c = resolveBranchWorkspaceConfig(config);
  return (
    c.enabled &&
    (c.tenant_ids.length === 0 || c.tenant_ids.includes(tenantId)) &&
    (c.branch_ids.length === 0 || c.branch_ids.includes(branchId))
  );
}
