import { BranchRepository, LinksRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchID,
  Link,
  LinkCreate,
  Params,
  UUID,
} from '@agor/core/types';
import { isTeammate, TEAMMATE_PROMOTION_METADATA_KEY } from '@agor/core/types';
import { ensureLinkOwnerAccess, LINK_OWNER_ACCESS_MODE } from './link-owner-authorization.js';
import { getTrustedTransferTarget } from './link-transfer-policy.js';

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

const LINK_PROMOTION_TRANSFER_ERROR = {
  fileLifetime: 'File-backed links cannot be promoted until file lifetime is defined',
  internalAccess: 'Internal links cannot be promoted until target access checks are enforced',
  missingTarget: 'Source link has no trusted target to promote',
} as const;

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

    await ensureLinkOwnerAccess({
      mode: LINK_OWNER_ACCESS_MODE.mutate,
      owner: { branch_id: teammateBranch.branch_id },
      options: {
        branchRepository: this.branchRepository,
        branchRbacEnabled: this.options.branchRbacEnabled,
        superadminOpts: this.options.superadminOpts,
      },
      params,
    });

    const callerId = (params?.user?.user_id as UUID | undefined) ?? null;
    const targetFields = getTrustedTransferTarget(source, LINK_PROMOTION_TRANSFER_ERROR);
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
