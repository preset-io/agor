import { BranchRepository, LinksRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Link,
  LinkMoveRequest,
  LinkMoveResult,
  LinkOwner,
  Params,
  Session,
} from '@agor/core/types';
import { LINK_MOVE_TARGET } from '@agor/core/types';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { ensureLinkOwnerAccess, LINK_OWNER_ACCESS_MODE } from './link-owner-authorization.js';
import { getTrustedTransferTarget } from './link-transfer-policy.js';

export const LINK_MOVE_ROUTE = '/links/:linkId/move';
export const LINK_MOVE_AUTH_ACTION = 'move links between owners';

const LINK_SERVICE_PATH = 'links';
const LINK_SERVICE_EVENT = {
  created: 'created',
  patched: 'patched',
  removed: 'removed',
} as const;

const LINK_MOVE_ERROR = {
  linkIdRequired: 'Link ID is required',
  branchIdRequired: 'branch_id is required when moving a link to a branch',
  sessionIdRequired: 'session_id is required when moving a link to a session',
  invalidTarget: 'Link move target must be branch or session',
  invalidOwner: 'Link has no valid owner',
  sameOwner: 'The link is already owned by this destination',
  archivedBranch: 'Links cannot move to an archived branch',
  archivedSession: 'Links cannot move to an archived session',
} as const;

interface LinkMoveRouteParams extends AuthenticatedParams {
  route?: Record<string, string | undefined>;
}

interface LinkMoveSessionsService {
  get(id: string, params?: Params): Promise<Session>;
}

interface LinkMoveServiceOptions {
  app: Application;
  db: TenantScopeAwareDatabase;
  branchRepository?: BranchRepository;
  branchRbacEnabled: boolean;
  sessionsService: LinkMoveSessionsService;
  superadminOpts: { allowSuperadmin: boolean };
}

type LinksReadService = {
  get(id: string, params?: Params): Promise<Link>;
};

function linkIdFromParams(params?: LinkMoveRouteParams): string | null {
  return params?.route?.linkId ?? params?.route?.id ?? null;
}

function ownerFromRequest(data: LinkMoveRequest): LinkOwner {
  if (data?.target === LINK_MOVE_TARGET.branch) {
    if (!data.branch_id) throw new BadRequest(LINK_MOVE_ERROR.branchIdRequired);
    return { branch_id: data.branch_id };
  }
  if (data?.target === LINK_MOVE_TARGET.session) {
    if (!data.session_id) throw new BadRequest(LINK_MOVE_ERROR.sessionIdRequired);
    return { session_id: data.session_id };
  }
  throw new BadRequest(LINK_MOVE_ERROR.invalidTarget);
}

function ownerFromLink(link: Link): LinkOwner {
  if (link.branch_id && !link.session_id) return { branch_id: link.branch_id };
  if (link.session_id && !link.branch_id) return { session_id: link.session_id };
  throw new BadRequest(LINK_MOVE_ERROR.invalidOwner);
}

function hasOwner(link: Link, owner: LinkOwner): boolean {
  return owner.branch_id
    ? link.branch_id === owner.branch_id && !link.session_id
    : link.session_id === owner.session_id && !link.branch_id;
}

export class LinkMoveService {
  private readonly branchRepository: BranchRepository;
  private readonly linksRepository: LinksRepository;

  constructor(private readonly options: LinkMoveServiceOptions) {
    this.branchRepository = options.branchRepository ?? new BranchRepository(options.db);
    this.linksRepository = new LinksRepository(options.db);
  }

  private linksService(): LinksReadService {
    return this.options.app.service(LINK_SERVICE_PATH) as unknown as LinksReadService;
  }

  private async ensureDestinationExists(owner: LinkOwner): Promise<void> {
    if (owner.branch_id) {
      const branch = await this.branchRepository.findById(owner.branch_id);
      if (!branch) throw new NotFound(`Branch not found: ${owner.branch_id}`);
      if (branch.archived) throw new BadRequest(LINK_MOVE_ERROR.archivedBranch);
      return;
    }

    const session = await this.options.sessionsService.get(String(owner.session_id), {
      provider: undefined,
    });
    if (session.archived) throw new BadRequest(LINK_MOVE_ERROR.archivedSession);
  }

  async create(data: LinkMoveRequest, params?: LinkMoveRouteParams): Promise<LinkMoveResult> {
    const linkId = linkIdFromParams(params);
    if (!linkId) throw new BadRequest(LINK_MOVE_ERROR.linkIdRequired);
    const destinationOwner = ownerFromRequest(data);

    // Visibility is resolved through the ordinary links service before the
    // stronger source/destination mutation checks run.
    const source = await this.linksService().get(linkId, params);
    const sourceOwner = ownerFromLink(source);
    if (hasOwner(source, destinationOwner)) throw new BadRequest(LINK_MOVE_ERROR.sameOwner);
    getTrustedTransferTarget(source);

    const authorizationOptions = {
      branchRepository: this.branchRepository,
      branchRbacEnabled: this.options.branchRbacEnabled,
      sessionsService: this.options.sessionsService,
      superadminOpts: this.options.superadminOpts,
    };
    await ensureLinkOwnerAccess({
      mode: LINK_OWNER_ACCESS_MODE.mutate,
      owner: sourceOwner,
      options: authorizationOptions,
      params,
    });
    await this.ensureDestinationExists(destinationOwner);
    await ensureLinkOwnerAccess({
      mode: LINK_OWNER_ACCESS_MODE.mutate,
      owner: destinationOwner,
      options: authorizationOptions,
      params,
    });

    const result = await this.linksRepository.move(linkId, destinationOwner, {
      expectedRevision: source.revision,
    });

    emitServiceEvent(this.options.app, {
      path: LINK_SERVICE_PATH,
      event: LINK_SERVICE_EVENT.removed,
      data: result.previous_link,
      id: result.previous_link.link_id,
      params,
    });
    emitServiceEvent(this.options.app, {
      path: LINK_SERVICE_PATH,
      event: result.merged ? LINK_SERVICE_EVENT.patched : LINK_SERVICE_EVENT.created,
      data: result.link,
      id: result.link.link_id,
      params,
    });
    return result;
  }
}

export function createLinkMoveService(options: LinkMoveServiceOptions): LinkMoveService {
  return new LinkMoveService(options);
}
