import { BranchRepository, LinksRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
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
import { isAssistant } from '@agor/core/types';
import {
  isSuperAdmin,
  PERMISSION_RANK,
  resolveBranchPermission,
} from '../utils/branch-authorization.js';

interface LinkPromotionRouteParams extends AuthenticatedParams {
  route?: Record<string, string | undefined>;
}

export interface LinkPromotionData {
  target?: 'assistant';
  assistant_branch_id?: BranchID | string;
}

interface LinkPromotionServiceOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  branchRepository?: BranchRepository;
  branchRbacEnabled: boolean;
  superadminOpts: { allowSuperadmin: boolean };
}

type LinksCrudService = {
  get(id: string, params?: Params): Promise<Link>;
  create(data: Partial<LinkCreate>, params?: Params): Promise<Link>;
  patch(id: string, data: Partial<Link>, params?: Params): Promise<Link>;
};

function sourceLinkIdFromParams(params?: LinkPromotionRouteParams): string | null {
  return params?.route?.sourceLinkId ?? params?.route?.id ?? null;
}

function trustedTargetCreateFields(source: Link): Partial<LinkCreate> {
  if (source.file_path || source.source === 'upload') {
    throw new BadRequest('File-backed links cannot be promoted until upload retention is defined');
  }
  if (source.kind === 'internal' || source.target_object_type || source.target_object_id) {
    throw new BadRequest(
      'Internal links cannot be promoted until target access checks are enforced'
    );
  }
  if (source.url) {
    return {
      url: source.url,
      ref_uri: null,
      file_path: null,
      target_object_type: null,
      target_object_id: null,
    };
  }
  if (source.kind === 'kb_ref' && source.ref_uri) {
    return {
      url: null,
      ref_uri: source.ref_uri,
      file_path: null,
      target_object_type: null,
      target_object_id: null,
    };
  }
  throw new BadRequest('Source link has no trusted target to promote');
}

export class LinkPromotionService {
  private branchRepository: BranchRepository;
  private linksRepository: LinksRepository;

  constructor(private readonly options: LinkPromotionServiceOptions) {
    this.branchRepository = options.branchRepository ?? new BranchRepository(options.db);
    this.linksRepository = new LinksRepository(options.db);
  }

  private linksService(): LinksCrudService {
    return this.options.app.service('links') as unknown as LinksCrudService;
  }

  private async ensureCanMutateAssistantBranch(
    assistantBranch: Branch,
    params?: LinkPromotionRouteParams
  ): Promise<void> {
    if (!this.options.branchRbacEnabled || !params?.provider) return;
    const user = params.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if (user._isServiceAccount) return;
    if (isSuperAdmin(user.role, this.options.superadminOpts.allowSuperadmin)) return;

    const userId = user.user_id as UUID;
    const isOwner = await this.branchRepository.isOwner(assistantBranch.branch_id, userId);
    const branchPermission = await this.branchRepository.resolveUserPermission(
      assistantBranch,
      userId
    );
    const effectiveLevel = resolveBranchPermission(
      assistantBranch,
      userId,
      isOwner,
      user.role,
      this.options.superadminOpts.allowSuperadmin,
      branchPermission
    );

    if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.all) return;
    throw new Forbidden(
      `You need 'all' permission to promote links to this assistant. You have '${effectiveLevel}' permission.`
    );
  }

  async create(data: LinkPromotionData, params?: LinkPromotionRouteParams): Promise<Link> {
    const sourceLinkId = sourceLinkIdFromParams(params);
    if (!sourceLinkId) throw new BadRequest('Source link ID is required');
    if (data?.target !== 'assistant') {
      throw new BadRequest("links promote target must be 'assistant'");
    }
    const assistantBranchId = data.assistant_branch_id;
    if (!assistantBranchId) throw new BadRequest('assistant_branch_id is required');

    // Important: load through links.get with the original caller params so the
    // source link's normal visibility hooks decide whether this caller can see it.
    const source = await this.linksService().get(sourceLinkId, params);
    const assistantBranch = await this.branchRepository.findById(String(assistantBranchId));
    if (!assistantBranch) throw new NotFound(`Assistant branch not found: ${assistantBranchId}`);
    if (!isAssistant(assistantBranch)) throw new BadRequest('Target branch is not an assistant');

    await this.ensureCanMutateAssistantBranch(assistantBranch, params);

    const callerId = (params?.user?.user_id as UUID | undefined) ?? null;
    const targetFields = trustedTargetCreateFields(source);
    const existing = await this.linksRepository.findByOwnerAndTarget({
      branch_id: assistantBranch.branch_id,
      session_id: null,
      ...targetFields,
    });
    if (existing) {
      return this.linksService().patch(
        existing.link_id,
        { is_pinned: true },
        { ...params, provider: undefined }
      );
    }

    const createData: Partial<LinkCreate> = {
      branch_id: assistantBranch.branch_id,
      session_id: null,
      kind: source.kind,
      source: 'manual',
      ...targetFields,
      is_pinned: true,
      title: source.title ?? null,
      created_by: callerId,
    };

    // Promotion is an explicit user action, so the assistant-owned copy starts
    // with manual provenance and no metadata from the source ownership boundary.
    return this.linksService().create(createData, { ...params, provider: undefined });
  }
}

export function createLinkPromotionService(
  options: LinkPromotionServiceOptions
): LinkPromotionService {
  return new LinkPromotionService(options);
}
