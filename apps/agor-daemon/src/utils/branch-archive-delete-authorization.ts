import type { BranchRepository } from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type { BranchID, BranchMetadataAction, HookContext } from '@agor/core/types';
import { isBranchArchiveOrDeleteOptions, isBranchUnarchiveOptions } from '@agor/core/types';
import {
  cacheBranchAccess,
  ensureBranchOwnerOrAdmin,
  ensureBranchPermission,
} from './branch-authorization.js';

/**
 * Process-local capability proving the hooked archive/delete service boundary
 * completed its branch-control authorization. External callers cannot forge a
 * WeakSet membership through Feathers params or MCP input.
 */
const authorizedParams = new WeakMap<
  object,
  { branchId: BranchID; metadataAction: BranchMetadataAction }
>();
const authorizedUnarchiveParams = new WeakMap<object, BranchID>();

export function markBranchUnarchiveAuthorized(
  params: HookContext['params'],
  branchId: BranchID
): void {
  authorizedUnarchiveParams.set(params, branchId);
}

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

export function consumeBranchUnarchiveAuthorization(
  params: HookContext['params'],
  branchId: BranchID
): void {
  const grantedBranchId = authorizedUnarchiveParams.get(params);
  authorizedUnarchiveParams.delete(params);
  if (grantedBranchId !== branchId) {
    throw new Forbidden(
      'Branch unarchive must be invoked through the authorized unarchive service'
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
    branchRbacEnabled: boolean;
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
  if (options.branchRbacEnabled) {
    ensureBranchPermission('all', 'archive or delete branches', options.superadminOpts)(context);
  } else {
    ensureBranchOwnerOrAdmin('archive/delete branches')(context);
  }

  const { metadataAction } = context.data;
  // Repository lookups accept short/uppercase prefixes but every trusted
  // boundary after this hook must use the canonical UUID. The route handler
  // reads this same params object after before hooks finish.
  context.params.route = { ...(context.params.route ?? {}), id: branch.branch_id };
  markBranchArchiveDeleteAuthorized(context.params, branch.branch_id, metadataAction);
  return context;
}

/** Canonical branch-control gate for the unarchive service and MCP route. */
export async function authorizeBranchUnarchive(
  context: HookContext,
  options: {
    branchRepository: BranchRepository;
    branchRbacEnabled: boolean;
    superadminOpts?: { allowSuperadmin?: boolean };
  }
): Promise<HookContext> {
  const id = context.params.route?.id;
  if (!id) throw new Error('Branch ID required');
  if (!isBranchUnarchiveOptions(context.data)) {
    throw new BadRequest('Invalid branch unarchive options');
  }

  const branch = await options.branchRepository.findById(id);
  if (!branch) throw new Forbidden(`Branch not found: ${id}`);

  await cacheBranchAccess(context.params, options.branchRepository, branch);
  if (options.branchRbacEnabled) {
    ensureBranchPermission('all', 'unarchive branches', options.superadminOpts)(context);
  } else {
    ensureBranchOwnerOrAdmin('unarchive branches')(context);
  }

  context.params.route = { ...(context.params.route ?? {}), id: branch.branch_id };
  markBranchUnarchiveAuthorized(context.params, branch.branch_id);
  return context;
}
