import type { BranchRepository } from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  BranchID,
  Link,
  LinkCreate,
  Params,
  UUID,
} from '@agor/core/types';
import { isAssistant, ROLES } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization.js';
import { PERMISSION_RANK, resolveBranchPermission } from '../utils/branch-authorization.js';

export interface LinkPromotionRequest {
  target?: 'assistant';
  assistant_branch_id?: BranchID | string;
}

export interface LinkPromotionParams extends AuthenticatedParams {
  route?: {
    id?: string;
  };
}

export interface LinksServiceForPromotion {
  get(id: string, params?: Params): Promise<Link>;
  create(data: Partial<LinkCreate>, params?: Params): Promise<Link | Link[]>;
}

export interface PromoteLinkToAssistantDeps {
  linksService: LinksServiceForPromotion;
  branchRepository: BranchRepository;
  branchRbacEnabled: boolean;
  superadminOpts: { allowSuperadmin: boolean };
}

function getSourceOwner(link: Link): { branch_id: BranchID } | { session_id: Link['session_id'] } {
  if (link.branch_id) return { branch_id: link.branch_id };
  return { session_id: link.session_id };
}

function getSourceTarget(
  link: Link
):
  | Pick<LinkCreate, 'url'>
  | Pick<LinkCreate, 'ref_uri' | 'target_object_type' | 'target_object_id'>
  | Pick<LinkCreate, 'file_path'> {
  if (link.url) return { url: link.url };
  if (link.ref_uri) {
    return {
      ref_uri: link.ref_uri,
      target_object_type: link.target_object_type ?? null,
      target_object_id: link.target_object_id ?? null,
    };
  }
  if (link.file_path) return { file_path: link.file_path };
  throw new BadRequest('Source link has no promotable target');
}

async function ensureCanMutateAssistantBranch(args: {
  branch: Branch;
  branchRepository: BranchRepository;
  branchRbacEnabled: boolean;
  params: LinkPromotionParams | undefined;
  superadminOpts: { allowSuperadmin: boolean };
}): Promise<void> {
  const { branch, branchRepository, branchRbacEnabled, params, superadminOpts } = args;

  if (!isAssistant(branch)) {
    throw new BadRequest('Target branch is not an assistant branch');
  }

  if (!branchRbacEnabled || !params?.provider) return;
  if (params.user?._isServiceAccount) return;

  const user = params.user;
  if (!user) throw new NotAuthenticated('Authentication required');

  const isOwner = await branchRepository.isOwner(branch.branch_id, user.user_id as UUID);
  const branchPermission = await branchRepository.resolveUserPermission(
    branch,
    user.user_id as UUID
  );
  const effectiveLevel = resolveBranchPermission(
    branch,
    user.user_id as UUID,
    isOwner,
    user.role,
    superadminOpts.allowSuperadmin,
    branchPermission
  );

  if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.all) return;

  throw new Forbidden(
    `You need 'all' permission to promote links to this assistant. You have '${effectiveLevel}' permission.`
  );
}

function buildPromotedMetadata(args: {
  source: Link;
  promotedAt: string;
  promotedBy?: UUID | null;
}): Link['metadata'] {
  const sourceMetadata =
    args.source.metadata &&
    typeof args.source.metadata === 'object' &&
    !Array.isArray(args.source.metadata)
      ? args.source.metadata
      : {};

  return {
    ...sourceMetadata,
    promoted_from_link_id: args.source.link_id,
    promoted_from_owner: getSourceOwner(args.source),
    promoted_at: args.promotedAt,
    promoted_by: args.promotedBy ?? null,
  };
}

export async function promoteLinkToAssistant(
  deps: PromoteLinkToAssistantDeps,
  input: {
    sourceLinkId: string;
    assistantBranchId: string;
    params?: LinkPromotionParams;
  }
): Promise<Link> {
  const { linksService, branchRepository, branchRbacEnabled, superadminOpts } = deps;
  const { sourceLinkId, assistantBranchId, params } = input;

  if (!sourceLinkId) throw new BadRequest('Source link ID is required');
  if (!assistantBranchId) throw new BadRequest('assistant_branch_id is required');

  ensureMinimumRole(params, ROLES.MEMBER, 'promote links to assistant');

  const source = await linksService.get(sourceLinkId, params as Params);
  const assistantBranch = await branchRepository.findById(assistantBranchId);
  if (!assistantBranch) throw new NotFound(`Assistant branch not found: ${assistantBranchId}`);

  await ensureCanMutateAssistantBranch({
    branch: assistantBranch,
    branchRepository,
    branchRbacEnabled,
    params,
    superadminOpts,
  });

  const promotedAt = new Date().toISOString();
  const promotedBy = (params?.user?.user_id as UUID | undefined) ?? null;
  const target = getSourceTarget(source);
  const promoted = await linksService.create(
    {
      branch_id: assistantBranch.branch_id,
      session_id: null,
      source_message_id: null,
      kind: source.kind,
      source: source.file_path ? source.source : 'manual',
      ...target,
      is_pinned: true,
      title: source.title ?? null,
      mime_type: source.mime_type ?? null,
      metadata: buildPromotedMetadata({ source, promotedAt, promotedBy }),
      created_by: promotedBy,
    },
    { ...(params as Params), provider: undefined }
  );

  return Array.isArray(promoted) ? promoted[0] : promoted;
}

export class LinkPromotionService {
  constructor(
    private deps: Omit<PromoteLinkToAssistantDeps, 'linksService'> & {
      linksService: LinksServiceForPromotion;
    }
  ) {}

  async create(data: LinkPromotionRequest, params?: LinkPromotionParams): Promise<Link> {
    const sourceLinkId = params?.route?.id;
    if (!sourceLinkId) throw new BadRequest('Source link ID is required');
    if (data?.target && data.target !== 'assistant') {
      throw new BadRequest(`Unsupported promotion target: ${String(data.target)}`);
    }

    return promoteLinkToAssistant(
      {
        linksService: this.deps.linksService,
        branchRepository: this.deps.branchRepository,
        branchRbacEnabled: this.deps.branchRbacEnabled,
        superadminOpts: this.deps.superadminOpts,
      },
      {
        sourceLinkId,
        assistantBranchId: String(data?.assistant_branch_id ?? ''),
        params,
      }
    );
  }
}
