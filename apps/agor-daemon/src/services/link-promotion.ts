import { BranchRepository, LinksRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchID,
  Link,
  LinkCreate,
  LinkPromotionRequest,
  UUID,
} from '@agor/core/types';
import {
  isTeammate,
  LINK_PROMOTION_SOURCE_METADATA_KEY,
  LINK_PROMOTION_TARGET,
  TEAMMATE_PROMOTION_METADATA_KEY,
} from '@agor/core/types';
import { ensureLinkOwnerAccess, LINK_OWNER_ACCESS_MODE } from './link-owner-authorization.js';
import { getPromotableLinkTarget } from './link-promotion-policy.js';

interface LinkPromotionRouteParams extends AuthenticatedParams {
  route?: Record<string, string | undefined>;
}

interface LinkPromotionServiceOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  branchRepository?: BranchRepository;
  branchRbacEnabled: boolean;
  superadminOpts: { allowSuperadmin: boolean };
}

type LinksCrudService = {
  get(id: string, params?: AuthenticatedParams): Promise<Link>;
  create(
    data: Partial<LinkCreate>,
    params?: AuthenticatedParams & { _agorPreserveExistingOnCreate?: boolean }
  ): Promise<Link>;
};

function sourceLinkIdFromParams(params?: LinkPromotionRouteParams): string | null {
  return params?.route?.sourceLinkId ?? params?.route?.id ?? null;
}

const LINK_PROMOTION_ERROR = {
  sourceLinkIdRequired: 'Source link ID is required',
  branchIdRequired: 'branch_id is required when promoting to a branch',
  teammateBranchIdRequired: 'teammate_branch_id is required when promoting to a teammate',
  invalidTarget: 'Link promotion target must be branch or teammate',
  teammateRequired: 'Target branch is not a teammate',
  archivedBranch: 'Links cannot be promoted to an archived branch',
} as const;

const LINKS_SERVICE = 'links';
const LINK_SOURCE = {
  manual: 'manual',
  upload: 'upload',
} as const;
const PROMOTED_UPLOAD_METADATA_KEYS = ['filename', 'originalName', 'size'] as const;

function destinationBranchId(data: LinkPromotionRequest): BranchID {
  if (data?.target === LINK_PROMOTION_TARGET.branch) {
    if (!data.branch_id) throw new BadRequest(LINK_PROMOTION_ERROR.branchIdRequired);
    return data.branch_id;
  }
  if (data?.target === LINK_PROMOTION_TARGET.teammate) {
    if (!data.teammate_branch_id) {
      throw new BadRequest(LINK_PROMOTION_ERROR.teammateBranchIdRequired);
    }
    return data.teammate_branch_id;
  }
  throw new BadRequest(LINK_PROMOTION_ERROR.invalidTarget);
}

function promotedMetadata(source: Link, target: LinkPromotionRequest['target']) {
  const metadata: Record<string, unknown> = {
    [LINK_PROMOTION_SOURCE_METADATA_KEY]: {
      link_id: source.link_id,
      ...(source.branch_id ? { branch_id: source.branch_id } : {}),
      ...(source.session_id ? { session_id: source.session_id } : {}),
    },
    ...(target === LINK_PROMOTION_TARGET.teammate
      ? { [TEAMMATE_PROMOTION_METADATA_KEY]: true }
      : {}),
  };
  if (source.source === LINK_SOURCE.upload && source.metadata) {
    for (const key of PROMOTED_UPLOAD_METADATA_KEYS) {
      const value = source.metadata[key];
      if (value !== undefined) metadata[key] = value;
    }
  }
  return metadata;
}

export class LinkPromotionService {
  private branchRepository: BranchRepository;
  private linksRepository: LinksRepository;

  constructor(private readonly options: LinkPromotionServiceOptions) {
    this.branchRepository = options.branchRepository ?? new BranchRepository(options.db);
    this.linksRepository = new LinksRepository(options.db);
  }

  private linksService(): LinksCrudService {
    return this.options.app.service(LINKS_SERVICE) as unknown as LinksCrudService;
  }

  async create(data: LinkPromotionRequest, params?: LinkPromotionRouteParams): Promise<Link> {
    const sourceLinkId = sourceLinkIdFromParams(params);
    if (!sourceLinkId) throw new BadRequest(LINK_PROMOTION_ERROR.sourceLinkIdRequired);
    const targetBranchId = destinationBranchId(data);

    // Important: load through links.get with the original caller params so the
    // source link's normal visibility hooks decide whether this caller can see it.
    const source = await this.linksService().get(sourceLinkId, params);
    const targetBranch = await this.branchRepository.findById(String(targetBranchId));
    if (!targetBranch) throw new NotFound(`Branch not found: ${targetBranchId}`);
    if (targetBranch.archived) throw new BadRequest(LINK_PROMOTION_ERROR.archivedBranch);
    if (data.target === LINK_PROMOTION_TARGET.teammate && !isTeammate(targetBranch)) {
      throw new BadRequest(LINK_PROMOTION_ERROR.teammateRequired);
    }

    await ensureLinkOwnerAccess({
      mode: LINK_OWNER_ACCESS_MODE.mutate,
      owner: { branch_id: targetBranch.branch_id },
      options: {
        branchRepository: this.branchRepository,
        branchRbacEnabled: this.options.branchRbacEnabled,
        superadminOpts: this.options.superadminOpts,
      },
      params,
    });

    const callerId = (params?.user?.user_id as UUID | undefined) ?? null;
    const targetFields = getPromotableLinkTarget(source);
    const existing = await this.linksRepository.findByOwnerAndTarget({
      branch_id: targetBranch.branch_id,
      session_id: null,
      ...targetFields,
    });
    if (existing) {
      return existing;
    }

    const createData = {
      branch_id: targetBranch.branch_id,
      session_id: null,
      source_message_id: source.source_message_id ?? null,
      kind: source.kind,
      source: source.source === LINK_SOURCE.upload ? LINK_SOURCE.upload : LINK_SOURCE.manual,
      ...targetFields,
      is_pinned: true,
      title: source.title ?? null,
      mime_type: source.source === LINK_SOURCE.upload ? (source.mime_type ?? null) : null,
      metadata: promotedMetadata(source, data.target),
      created_by: callerId,
    } satisfies LinkCreate;

    // TODO: Add shared-upload reference counting before any future link cleanup
    // is allowed to delete bytes. Promoted upload links intentionally share file_path.
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
