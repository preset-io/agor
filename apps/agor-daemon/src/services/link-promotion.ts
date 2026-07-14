import { BranchRepository, LinksRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Link,
  LinkCreate,
  LinkOwner,
  LinkPromotionRequest,
  Session,
  SessionID,
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
  query?: Partial<LinkPromotionRequest>;
}

interface LinkPlacementServiceOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  branchRepository?: BranchRepository;
  branchRbacEnabled: boolean;
  sessionsService?: {
    get(id: string, params?: AuthenticatedParams): Promise<Session>;
  };
  superadminOpts: { allowSuperadmin: boolean };
}

type LinksCrudService = {
  find(
    params?: AuthenticatedParams & { query?: Record<string, unknown> }
  ): Promise<Link[] | { data: Link[] }>;
  get(id: string, params?: AuthenticatedParams): Promise<Link>;
  create(
    data: Partial<LinkCreate>,
    params?: AuthenticatedParams & { _agorPreserveExistingOnCreate?: boolean }
  ): Promise<Link>;
  remove(id: string, params?: AuthenticatedParams): Promise<Link>;
};

function sourceLinkIdFromParams(params?: LinkPromotionRouteParams): string | null {
  return params?.route?.sourceLinkId ?? params?.route?.id ?? null;
}

const LINK_PROMOTION_ERROR = {
  sourceLinkIdRequired: 'Source link ID is required',
  branchIdRequired: 'branch_id is required when promoting to a branch',
  sessionIdRequired: 'session_id is required when promoting to a session',
  teammateBranchIdRequired: 'teammate_branch_id is required when promoting to a teammate',
  invalidTarget: 'Link promotion target must be a branch, session, or teammate',
  teammateRequired: 'Target branch is not a teammate',
  archivedBranch: 'Links cannot be promoted to an archived branch',
  archivedSession: 'Links cannot be promoted to an archived session',
  sessionsUnavailable: 'Session-owned link placements are unavailable',
} as const;

const LINKS_SERVICE = 'links';
const LINK_SOURCE = {
  manual: 'manual',
  upload: 'upload',
} as const;
const PROMOTED_UPLOAD_METADATA_KEYS = ['filename', 'originalName', 'size'] as const;

interface ResolvedPlacementDestination {
  owner: LinkOwner;
}

function promotedMetadata(source: Link, target: LinkPromotionRequest['target']) {
  const existingProvenance = source.metadata?.[LINK_PROMOTION_SOURCE_METADATA_KEY];
  const provenance =
    existingProvenance && typeof existingProvenance === 'object'
      ? existingProvenance
      : {
          link_id: source.link_id,
          ...(source.branch_id ? { branch_id: source.branch_id } : {}),
          ...(source.session_id ? { session_id: source.session_id } : {}),
        };
  const metadata: Record<string, unknown> = {
    [LINK_PROMOTION_SOURCE_METADATA_KEY]: provenance,
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

export class LinkPlacementService {
  private branchRepository: BranchRepository;
  private linksRepository: LinksRepository;

  constructor(private readonly options: LinkPlacementServiceOptions) {
    this.branchRepository = options.branchRepository ?? new BranchRepository(options.db);
    this.linksRepository = new LinksRepository(options.db);
  }

  private linksService(): LinksCrudService {
    return this.options.app.service(LINKS_SERVICE) as unknown as LinksCrudService;
  }

  private async sourceLink(params?: LinkPromotionRouteParams): Promise<Link> {
    const sourceLinkId = sourceLinkIdFromParams(params);
    if (!sourceLinkId) throw new BadRequest(LINK_PROMOTION_ERROR.sourceLinkIdRequired);
    // Load through the public service so normal visibility hooks authorize the source.
    const { query: _query, ...sourceParams } = params ?? {};
    return this.linksService().get(sourceLinkId, sourceParams);
  }

  private async resolveDestination(
    data: LinkPromotionRequest,
    params?: LinkPromotionRouteParams
  ): Promise<ResolvedPlacementDestination> {
    if (data?.target === LINK_PROMOTION_TARGET.session) {
      if (!data.session_id) throw new BadRequest(LINK_PROMOTION_ERROR.sessionIdRequired);
      if (!this.options.sessionsService) {
        throw new BadRequest(LINK_PROMOTION_ERROR.sessionsUnavailable);
      }
      const session = await this.options.sessionsService.get(data.session_id, {
        ...params,
        provider: undefined,
      });
      if (session.archived) throw new BadRequest(LINK_PROMOTION_ERROR.archivedSession);
      return {
        owner: { branch_id: null, session_id: session.session_id as SessionID },
      };
    }

    const targetBranchId =
      data?.target === LINK_PROMOTION_TARGET.branch
        ? data.branch_id
        : data?.target === LINK_PROMOTION_TARGET.teammate
          ? data.teammate_branch_id
          : null;
    if (!targetBranchId) {
      if (data?.target === LINK_PROMOTION_TARGET.branch) {
        throw new BadRequest(LINK_PROMOTION_ERROR.branchIdRequired);
      }
      if (data?.target === LINK_PROMOTION_TARGET.teammate) {
        throw new BadRequest(LINK_PROMOTION_ERROR.teammateBranchIdRequired);
      }
      throw new BadRequest(LINK_PROMOTION_ERROR.invalidTarget);
    }

    const targetBranch = await this.branchRepository.findById(String(targetBranchId));
    if (!targetBranch) throw new NotFound(`Branch not found: ${targetBranchId}`);
    if (targetBranch.archived) throw new BadRequest(LINK_PROMOTION_ERROR.archivedBranch);
    if (data.target === LINK_PROMOTION_TARGET.teammate && !isTeammate(targetBranch)) {
      throw new BadRequest(LINK_PROMOTION_ERROR.teammateRequired);
    }
    return {
      owner: { branch_id: targetBranch.branch_id, session_id: null },
    };
  }

  private async authorizeDestination(
    destination: ResolvedPlacementDestination,
    params?: LinkPromotionRouteParams
  ): Promise<void> {
    await ensureLinkOwnerAccess({
      mode: LINK_OWNER_ACCESS_MODE.mutate,
      owner: destination.owner,
      options: {
        branchRepository: this.branchRepository,
        branchRbacEnabled: this.options.branchRbacEnabled,
        sessionsService: this.options.sessionsService,
        superadminOpts: this.options.superadminOpts,
      },
      params,
    });
  }

  private async findDestinationPlacement(
    source: Link,
    destination: ResolvedPlacementDestination
  ): Promise<Link | null> {
    return this.linksRepository.findByOwnerAndTarget({
      ...destination.owner,
      ...getPromotableLinkTarget(source),
    });
  }

  async find(params?: LinkPromotionRouteParams): Promise<Link[]> {
    const source = await this.sourceLink(params);
    getPromotableLinkTarget(source);
    const result = await this.linksService().find({
      ...params,
      query: { target_key: source.target_key },
    });
    return Array.isArray(result) ? result : result.data;
  }

  async create(data: LinkPromotionRequest, params?: LinkPromotionRouteParams): Promise<Link> {
    const source = await this.sourceLink(params);
    const destination = await this.resolveDestination(data, params);
    await this.authorizeDestination(destination, params);

    const callerId = (params?.user?.user_id as UUID | undefined) ?? null;
    const targetFields = getPromotableLinkTarget(source);
    const existing = await this.findDestinationPlacement(source, destination);
    if (existing) {
      return existing;
    }

    const createData = {
      ...destination.owner,
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

  async remove(_id: null, params?: LinkPromotionRouteParams): Promise<Link | null> {
    const data = params?.query as LinkPromotionRequest | undefined;
    if (!data) throw new BadRequest(LINK_PROMOTION_ERROR.invalidTarget);
    const source = await this.sourceLink(params);
    const destination = await this.resolveDestination(data, params);
    await this.authorizeDestination(destination, params);
    const existing = await this.findDestinationPlacement(source, destination);
    if (!existing) return null;
    const { query: _query, ...mutationParams } = params ?? {};
    return this.linksService().remove(existing.link_id, {
      ...mutationParams,
      provider: undefined,
    });
  }
}

export function createLinkPlacementService(
  options: LinkPlacementServiceOptions
): LinkPlacementService {
  return new LinkPlacementService(options);
}
