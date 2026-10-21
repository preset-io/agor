/**
 * `boards/:id/files`: the board's Files list, read-only.
 *
 * Four sources, each read with its own access rule inside the request's tenant
 * scope, then merged, searched, sorted and paged here. A board holds hundreds
 * of these, not millions, so paging each source in SQL is not worth it yet.
 *
 * - Artifacts on the board, on branches the caller can see, and public or the
 *   caller's own. Artifact `find()` does not apply the private rule, so it is
 *   applied here.
 * - Knowledge documents a session on the board last wrote as an agent, under
 *   Knowledge's read rules, without memory documents or other people's drafts.
 * - Branches on the board with an app or a pull request, that the caller can see.
 * - Active uploads from the board's conversations that the caller uploaded or
 *   whose branch they can see, the rule `GET /uploads/:ref/content` applies.
 */

import { matchSearchTokens, uniqueSearchTokens } from '@agor/core';
import {
  ArtifactRepository,
  BoardRepository,
  BranchRepository,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UploadRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  type Artifact,
  type AuthenticatedParams,
  BOARD_FILE_KIND_LABELS,
  BOARD_FILE_KINDS,
  BOARD_FILE_SORTS,
  BOARD_FILES_PAGE_SIZE,
  type BoardFileItem,
  type BoardFileKind,
  type BoardFileMadeBy,
  type BoardFileSort,
  type BoardFileSource,
  type BoardFilesPage,
  type BoardID,
  type Branch,
  type BranchID,
  getTeammateConfig,
  type KnowledgeDocument,
  type Params,
  type Session,
  type SessionID,
  type TenantID,
  type Upload,
  type UserID,
} from '@agor/core/types';
import { isSuperAdmin } from '../utils/branch-authorization.js';
import { isKnowledgeAdmin } from './knowledge-access.js';

export const BOARD_FILES_SERVICE_PATH = 'boards/:id/files';

export interface BoardFilesQueryOptions {
  q: string;
  kinds: ReadonlySet<BoardFileKind>;
  sort: BoardFileSort;
  sessionId?: SessionID;
  includeArchived: boolean;
  limit: number;
  skip: number;
}

const isKind = (value: unknown): value is BoardFileKind =>
  typeof value === 'string' && (BOARD_FILE_KINDS as readonly string[]).includes(value);

const toInteger = (value: unknown, fallback: number) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

/** Validates the query; `$limit` is capped at one page of 50. */
export function parseBoardFilesQuery(query: Record<string, unknown> = {}): BoardFilesQueryOptions {
  const rawKind = query.kind as unknown;
  const kindList =
    rawKind === undefined
      ? [...BOARD_FILE_KINDS]
      : typeof rawKind === 'object' && rawKind !== null && '$in' in rawKind
        ? (rawKind as { $in: unknown }).$in
        : [rawKind];
  if (!Array.isArray(kindList) || !kindList.every(isKind)) {
    throw new BadRequest(`kind must be one of ${BOARD_FILE_KINDS.join(', ')}`);
  }
  const sort = (query.sort ?? 'recent') as BoardFileSort;
  if (!BOARD_FILE_SORTS.includes(sort)) {
    throw new BadRequest(`sort must be one of ${BOARD_FILE_SORTS.join(', ')}`);
  }
  const includeArchived = query.include_archived === true || query.include_archived === 'true';
  const sessionId =
    typeof query.session_id === 'string' && query.session_id
      ? (query.session_id as SessionID)
      : undefined;
  if (includeArchived && !sessionId) {
    throw new BadRequest('include_archived is only allowed together with session_id');
  }
  return {
    q: typeof query.q === 'string' ? query.q : '',
    kinds: new Set(kindList),
    sort,
    sessionId,
    includeArchived,
    limit: Math.min(
      BOARD_FILES_PAGE_SIZE,
      Math.max(0, toInteger(query.$limit, BOARD_FILES_PAGE_SIZE))
    ),
    skip: Math.max(0, toInteger(query.$skip, 0)),
  };
}

/** An item plus the extra text search matches against (artifact description, document path). */
export interface BoardFileCandidate {
  item: BoardFileItem;
  searchText?: string[];
}

const recentFirst = (a: BoardFileItem, b: BoardFileItem) =>
  b.made_at.localeCompare(a.made_at) || a.id.localeCompare(b.id);

/** Search, sort and slice the merged sources into one page. */
export function pageBoardFiles(
  candidates: BoardFileCandidate[],
  options: Pick<BoardFilesQueryOptions, 'q' | 'sort' | 'limit' | 'skip'>
): BoardFilesPage {
  const tokens = uniqueSearchTokens(options.q);
  const matching = tokens.length
    ? candidates.filter(({ item, searchText = [] }) =>
        matchSearchTokens(tokens, [item.name, ...searchText])
      )
    : candidates;
  const items = matching.map(({ item }) => item);
  const byName = (a: BoardFileItem, b: BoardFileItem) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || recentFirst(a, b);
  const byType = (a: BoardFileItem, b: BoardFileItem) =>
    BOARD_FILE_KIND_LABELS[a.kind].localeCompare(BOARD_FILE_KIND_LABELS[b.kind]) ||
    recentFirst(a, b);
  items.sort(options.sort === 'name' ? byName : options.sort === 'type' ? byType : recentFirst);
  return {
    total: items.length,
    limit: options.limit,
    skip: options.skip,
    data: items.slice(options.skip, options.skip + options.limit),
  };
}

/** A conversation's name, as the Sessions list shows it. */
export function boardFileSessionTitle(session: Pick<Session, 'title' | 'description'>): string {
  if (session.title?.trim()) return session.title.trim();
  const firstLine = session.description?.trim().split('\n')[0]?.trim();
  if (!firstLine) return 'Conversation';
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

const toIso = (value: Date | string | null | undefined): string =>
  value ? new Date(value).toISOString() : new Date(0).toISOString();

function teammateMadeBy(branch: Branch | undefined): BoardFileMadeBy | null {
  const teammate = branch ? getTeammateConfig(branch) : null;
  if (!branch || !teammate) return null;
  return {
    teammate_branch_id: branch.branch_id,
    name: teammate.displayName || branch.name,
    ...(teammate.emoji ? { emoji: teammate.emoji } : {}),
  };
}

function userMadeBy(userId: string | null | undefined): BoardFileMadeBy {
  return { user_id: (userId ?? '') as UserID };
}

export class BoardFilesService {
  private readonly boards: BoardRepository;
  private readonly branches: BranchRepository;
  private readonly sessions: SessionRepository;
  private readonly artifacts: ArtifactRepository;
  private readonly documents: KnowledgeDocumentRepository;
  private readonly namespaces: KnowledgeNamespaceRepository;
  private readonly uploads: UploadRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private readonly options: { allowSuperadmin?: boolean } = {}
  ) {
    this.boards = new BoardRepository(db);
    this.branches = new BranchRepository(db);
    this.sessions = new SessionRepository(db);
    this.artifacts = new ArtifactRepository(db);
    this.documents = new KnowledgeDocumentRepository(db);
    this.namespaces = new KnowledgeNamespaceRepository(db);
    this.uploads = new UploadRepository(db);
  }

  async find(params?: Params): Promise<BoardFilesPage> {
    const authParams = params as AuthenticatedParams | undefined;
    const user = authParams?.user;
    if (!user?.user_id) throw new NotAuthenticated('Authentication required');
    const boardRef = (params as { route?: { id?: string } } | undefined)?.route?.id;
    if (!boardRef) throw new BadRequest('Board ID is required');
    const board = await this.boards.findBySlugOrId(boardRef);
    if (!board) throw new NotFound(`Board not found: ${boardRef}`);
    const boardId = board.board_id as BoardID;
    const options = parseBoardFilesQuery(params?.query as Record<string, unknown> | undefined);

    const userId = user.user_id as UserID;
    // The same bypass branch-scoped finds use; everyone else sees only branches they can see.
    const seesEveryBranch =
      !!user._isServiceAccount || isSuperAdmin(user.role, this.options.allowSuperadmin ?? true);
    const visibleToUserId = seesEveryBranch ? undefined : userId;

    // The board's conversations and branches this caller can see.
    const [visibleSessions, boardBranches] = await Promise.all([
      this.sessions.findByBoard(boardId, { visibleToUserId }),
      this.branches.findAll({ board_id: boardId, visibleToUserId }),
    ]);
    const sessionById = new Map<string, Session>(visibleSessions.map((s) => [s.session_id, s]));
    const branchById = new Map<string, Branch>(boardBranches.map((b) => [b.branch_id, b]));

    const wants = (kind: BoardFileKind) => options.kinds.has(kind);
    const [artifacts, documents, uploads] = await Promise.all([
      wants('artifact') ? this.readArtifacts(boardId, userId, visibleToUserId, options) : [],
      wants('document') ? this.readDocuments(boardId, user, options) : [],
      wants('upload')
        ? this.uploads.listForBoard(
            authParams?.tenant?.tenant_id ?? ('default' as TenantID),
            boardId,
            {
              visibleToUserId,
              sessionId: options.sessionId,
            }
          )
        : [],
    ]);

    // Conversations named by an artifact or document that are not on this board
    // (the branch moved): visible ones keep their link; deleted ones read as none.
    const offBoard = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.source_session_id && !sessionById.has(artifact.source_session_id)) {
        offBoard.add(artifact.source_session_id);
      }
    }
    for (const doc of documents) {
      if (doc.updated_by_session_id && !sessionById.has(doc.updated_by_session_id)) {
        offBoard.add(doc.updated_by_session_id);
      }
    }
    const missingSessions = new Set<string>();
    if (offBoard.size > 0) {
      const found = (
        await Promise.all([...offBoard].map((id) => this.sessions.findById(id)))
      ).filter((s): s is Session => !!s);
      for (const id of offBoard) {
        if (!found.some((s) => s.session_id === id)) missingSessions.add(id);
      }
      const visibleBranches = await this.branches.findAll({
        branchIds: [...new Set(found.map((s) => s.branch_id as BranchID))],
        visibleToUserId,
      });
      for (const branch of visibleBranches) branchById.set(branch.branch_id, branch);
      for (const session of found) {
        if (branchById.has(session.branch_id)) sessionById.set(session.session_id, session);
      }
    }

    const sourceOf = (sessionId: string | null | undefined): BoardFileSource => {
      if (!sessionId || missingSessions.has(sessionId)) return 'board';
      const session = sessionById.get(sessionId);
      return session
        ? { session_id: session.session_id as SessionID, title: boardFileSessionTitle(session) }
        : 'private';
    };
    const sessionBranch = (sessionId: string | null | undefined) => {
      const session = sessionId ? sessionById.get(sessionId) : undefined;
      return session ? branchById.get(session.branch_id) : undefined;
    };

    const candidates: BoardFileCandidate[] = [];
    for (const artifact of artifacts) {
      candidates.push({
        item: {
          kind: 'artifact',
          id: artifact.artifact_id,
          name: artifact.name,
          made_at: toIso(artifact.updated_at),
          made_by:
            teammateMadeBy(
              sessionBranch(artifact.source_session_id) ??
                (artifact.branch_id ? branchById.get(artifact.branch_id) : undefined)
            ) ?? userMadeBy(artifact.created_by),
          source: sourceOf(artifact.source_session_id),
          ...(artifact.build_status === 'success' ? { status: 'Live' } : {}),
          ...(options.includeArchived ? { archived: !!artifact.archived } : {}),
        },
        searchText: artifact.description ? [artifact.description] : undefined,
      });
    }
    for (const doc of documents) {
      const teammate = teammateMadeBy(sessionBranch(doc.updated_by_session_id));
      candidates.push({
        item: {
          kind: 'document',
          id: doc.document_id,
          name: doc.title || doc.path,
          made_at: toIso(doc.updated_at ?? doc.created_at),
          made_by:
            teammate ??
            (doc.updated_by_teammate_name
              ? { name: doc.updated_by_teammate_name }
              : userMadeBy(doc.created_by)),
          source: sourceOf(doc.updated_by_session_id),
          status: doc.status === 'published' ? 'Shared' : 'Draft',
          ...(options.includeArchived ? { archived: !!doc.archived } : {}),
        },
        searchText: [doc.path],
      });
    }
    if (wants('app')) {
      const sessionBranchId = options.sessionId
        ? sessionById.get(options.sessionId)?.branch_id
        : undefined;
      for (const branch of boardBranches) {
        if (branch.archived || !(branch.app_url || branch.pull_request_url)) continue;
        if (options.sessionId && branch.branch_id !== sessionBranchId) continue;
        const newest = visibleSessions
          .filter((s) => s.branch_id === branch.branch_id)
          .sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''))[0];
        const teammate = teammateMadeBy(branch);
        candidates.push({
          item: {
            kind: 'app',
            id: branch.branch_id,
            name: teammate && 'name' in teammate ? teammate.name : branch.name,
            made_at: toIso(branch.updated_at),
            made_by: teammate ?? userMadeBy(newest?.created_by ?? branch.created_by),
            source: newest ? sourceOf(newest.session_id) : 'board',
            status: branch.pull_request_url ? 'Ready to review' : 'Live',
            ...(branch.app_url ? { app_url: branch.app_url } : {}),
            ...(branch.pull_request_url ? { pull_request_url: branch.pull_request_url } : {}),
          },
          searchText: [branch.name],
        });
      }
    }
    for (const upload of uploads) {
      candidates.push({ item: this.uploadItem(upload, sourceOf(upload.sessionId)) });
    }

    return pageBoardFiles(candidates, options);
  }

  private async readArtifacts(
    boardId: BoardID,
    userId: UserID,
    visibleToUserId: UserID | undefined,
    options: BoardFilesQueryOptions
  ): Promise<Artifact[]> {
    const rows = await this.artifacts.findAll({
      board_id: boardId,
      ...(options.includeArchived ? {} : { archived: false }),
      visibleToUserId,
      projection: 'metadata',
    });
    // The private rule `isVisibleTo` applies everywhere a payload is served:
    // public, or the caller made it. No role bypasses it.
    return rows.filter(
      (artifact) =>
        (artifact.public || artifact.created_by === userId) &&
        (!options.sessionId || artifact.source_session_id === options.sessionId)
    );
  }

  private async readDocuments(
    boardId: BoardID,
    user: NonNullable<AuthenticatedParams['user']>,
    options: BoardFilesQueryOptions
  ): Promise<KnowledgeDocument[]> {
    const userId = user.user_id as UserID;
    const asAdmin = isKnowledgeAdmin(user as Parameters<typeof isKnowledgeAdmin>[0]);
    return this.documents.findForBoard(boardId, {
      read: asAdmin
        ? { as_admin: true }
        : {
            as_admin: false,
            user_id: userId,
            namespace_ids: await this.namespaces.findReadableNamespaceIds(userId),
          },
      draftUserId: userId,
      sessionId: options.sessionId,
      includeArchived: options.includeArchived,
    });
  }

  private uploadItem(upload: Upload, source: BoardFileSource): BoardFileItem {
    return {
      kind: 'upload',
      id: upload.ref,
      name: upload.displayName,
      made_at: toIso(upload.createdAt),
      made_by: userMadeBy(upload.createdBy),
      source,
      mime_type: upload.mimeType,
      size_bytes: upload.size,
    };
  }
}

/** Registers the read-only Files list. Hooks: `register-hooks.ts` (auth and board view access). */
export function setupBoardFilesService(
  app: import('@agor/core/feathers').Application,
  db: TenantScopeAwareDatabase,
  options: { allowSuperadmin?: boolean } = {}
) {
  // Spelled out (it equals BOARD_FILES_SERVICE_PATH) so the realtime policy source scan sees it.
  app.use('boards/:id/files', new BoardFilesService(db, options), { methods: ['find'] });
}
