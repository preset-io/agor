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
import { isTeammate, TEAMMATE_PROMOTION_METADATA_KEY } from '@agor/core/types';
import {
  isSuperAdmin,
  PERMISSION_RANK,
  resolveBranchPermission,
} from '../utils/branch-authorization.js';

interface LinkPromotionRouteParams extends AuthenticatedParams {
  route?: Record<string, string | undefined>;
}

interface LinkPromotionData {
  target?: 'teammate';
  teammate_branch_id?: BranchID | string;
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
  create(
    data: Partial<LinkCreate>,
    params?: Params & { _agorPreserveExistingOnCreate?: boolean }
  ): Promise<Link>;
};

function sourceLinkIdFromParams(params?: LinkPromotionRouteParams): string | null {
  return params?.route?.sourceLinkId ?? params?.route?.id ?? null;
}

type TrustedTargetCreateFields =
  | {
      url: string;
      ref_uri: null;
      file_path: null;
      target_object_type: null;
      target_object_id: null;
    }
  | {
      url: null;
      ref_uri: string;
      file_path: null;
      target_object_type: Link['target_object_type'];
      target_object_id: Link['target_object_id'];
    };

function trustedTargetCreateFields(source: Link): TrustedTargetCreateFields {
  if (source.source === 'upload' || source.file_path) {
    throw new BadRequest('File-backed links cannot be promoted until file lifetime is defined');
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

  private async ensureCanMutateTeammateBranch(
    teammateBranch: Branch,
    params?: LinkPromotionRouteParams
  ): Promise<void> {
    if (!this.options.branchRbacEnabled || !params?.provider) return;
    const user = params.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if (user._isServiceAccount) return;
    if (isSuperAdmin(user.role, this.options.superadminOpts.allowSuperadmin)) return;

    const userId = user.user_id as UUID;
    const isOwner = await this.branchRepository.isOwner(teammateBranch.branch_id, userId);
    const branchPermission = await this.branchRepository.resolveUserPermission(
      teammateBranch,
      userId
    );
    const effectiveLevel = resolveBranchPermission(
      teammateBranch,
      userId,
      isOwner,
      user.role,
      this.options.superadminOpts.allowSuperadmin,
      branchPermission
    );

    if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.all) return;
    throw new Forbidden(
      `You need 'all' permission to promote links to this teammate. You have '${effectiveLevel}' permission.`
    );
  }

  async create(data: LinkPromotionData, params?: LinkPromotionRouteParams): Promise<Link> {
    const sourceLinkId = sourceLinkIdFromParams(params);
    if (!sourceLinkId) throw new BadRequest('Source link ID is required');
    if (data?.target !== 'teammate') {
      throw new BadRequest("links promote target must be 'teammate'");
    }
    const teammateBranchId = data.teammate_branch_id;
    if (!teammateBranchId) throw new BadRequest('teammate_branch_id is required');

    // Important: load through links.get with the original caller params so the
    // source link's normal visibility hooks decide whether this caller can see it.
    const source = await this.linksService().get(sourceLinkId, params);
    const teammateBranch = await this.branchRepository.findById(String(teammateBranchId));
    if (!teammateBranch) throw new NotFound(`Teammate branch not found: ${teammateBranchId}`);
    if (!isTeammate(teammateBranch)) throw new BadRequest('Target branch is not a teammate');

    await this.ensureCanMutateTeammateBranch(teammateBranch, params);

    const callerId = (params?.user?.user_id as UUID | undefined) ?? null;
    const targetFields = trustedTargetCreateFields(source);
    const existing = await this.linksRepository.findByOwnerAndTarget({
      branch_id: teammateBranch.branch_id,
      session_id: null,
      ...targetFields,
    });
    if (existing) {
      return existing;
    }

    const createData = {
      branch_id: teammateBranch.branch_id,
      session_id: null,
      kind: source.kind,
      source: 'manual' as const,
      ...targetFields,
      is_pinned: true,
      title: source.title ?? null,
      mime_type: null,
      metadata: { [TEAMMATE_PROMOTION_METADATA_KEY]: true },
      created_by: callerId,
    } satisfies LinkCreate;

    // Promotion is an explicit user action, so the teammate-owned copy starts
    // with manual provenance and no metadata from the source ownership boundary.
    return this.linksService().create(createData, {
      ...params,
      provider: undefined,
      _agorPreserveExistingOnCreate: true,
    });
  }
}

export function createLinkPromotionService(
  options: LinkPromotionServiceOptions
): LinkPromotionService {
  return new LinkPromotionService(options);
}
