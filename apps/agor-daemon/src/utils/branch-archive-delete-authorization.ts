import type { BranchRepository } from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { BranchID, BranchMetadataAction, HookContext } from '@agor/core/types';
import { isBranchArchiveOrDeleteOptions } from '@agor/core/types';
import { cacheBranchAccess, ensureBranchPermission } from './branch-authorization.js';

/**
 * Process-local capability proving the hooked archive/delete service boundary
 * completed its branch-control authorization. External callers cannot forge a
 * WeakSet membership through Feathers params or MCP input.
 */
const authorizedParams = new WeakMap<
  object,
  { branchId: BranchID; metadataAction: BranchMetadataAction }
>();

export function markBranchArchiveDeleteAuthorized(
  params: HookContext['params'],
  branchId: BranchID,
  metadataAction: BranchMetadataAction
): void {
  authorizedParams.set(params, { branchId, metadataAction });
}

export function consumeBranchArchiveDeleteAuthorization(
  params: HookContext['params'],
  branchId: BranchID,
  metadataAction: BranchMetadataAction
): void {
  const grant = authorizedParams.get(params);
  authorizedParams.delete(params);
  if (grant?.branchId !== branchId || grant.metadataAction !== metadataAction) {
    throw new Forbidden(
      'Branch archive/delete must be invoked through the authorized archive-or-delete service'
    );
  }
}

/**
 * Canonical branch-control gate for the long-running archive/delete service.
 * The caller supplies a tenant DB scope. This function resolves the canonical
 * branch ID, authorizes control, and grants the process-local capability before
 * any long-running side effect. Realtime visibility is intentionally captured
 * later, in the transaction that performs a hard delete.
 */
export async function authorizeBranchArchiveDelete(
  context: HookContext,
  options: {
    branchRepository: BranchRepository;
    superadminOpts?: { allowSuperadmin?: boolean };
  }
): Promise<HookContext> {
  const id = context.params.route?.id;
  if (!id) throw new Error('Branch ID required');
  if (!isBranchArchiveOrDeleteOptions(context.data)) {
    throw new BadRequest('Invalid branch archive/delete options');
  }

  const branch = await options.branchRepository.findById(id);
  if (!branch) throw new Forbidden(`Branch not found: ${id}`);

  await cacheBranchAccess(context.params, options.branchRepository, branch);
  ensureBranchPermission('all', 'archive or delete branches', options.superadminOpts)(context);

  const { metadataAction } = context.data;
  // Repository lookups accept short/uppercase prefixes but every trusted
  // boundary after this hook must use the canonical UUID. The route handler
  // reads this same params object after before hooks finish.
  context.params.route = { ...(context.params.route ?? {}), id: branch.branch_id };
  markBranchArchiveDeleteAuthorized(context.params, branch.branch_id, metadataAction);
  return context;
}
