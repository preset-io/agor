/**
 * `.agor` export: serialize one or more AI teammates into a streaming,
 * secret-free zip using the existing serializers (board blob, Knowledge
 * repository v2, repository rows → section DTOs) plus an executor-collected
 * fragment for git history and Claude memory.
 *
 * Authorization: the exporter needs `all` on every teammate branch. Sessions
 * are the exporter's own unless "include others' sessions" is checked, and
 * then only sessions on a branch the exporter fully controls. Secrets never
 * enter the pack: requirement lists carry names only, MCP definitions are
 * stripped of env/header/auth values, free text is scanned (session text is
 * redacted, everything else aborts on a hit).
 *
 * Database reads run in short tenant units; the route holds no transaction
 * while bytes stream.
 */

import {
  AGOR_PACK_FRAGMENT_KEY,
  type AgorPackWriter,
  assertNoSecrets,
  assertNoSecretsDeep,
  classifyEnvironmentVariants,
  claudeProjectSlug,
  forEachPackFragmentEntry,
  packSequence,
  redactSecretsDeep,
  scanForSecrets,
  teammatePackPath,
} from '@agor/core/agor-pack';
import type { AgorConfig } from '@agor/core/config';
import {
  AgenticToolPresetRepository,
  ArtifactRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  GatewayChannelRepository,
  KnowledgeNamespaceRepository,
  KnowledgeTransferRepository,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UploadRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  AGOR_PACK,
  type AgorPackArchivedSkips,
  type AgorPackArtifactFile,
  type AgorPackAuthor,
  type AgorPackBoardFile,
  type AgorPackExportOptions,
  type AgorPackFlaggedSession,
  type AgorPackManifest,
  type AgorPackMessage,
  type AgorPackPreflightTeammate,
  type AgorPackRequirements,
  type AgorPackSchedule,
  type AgorPackSessionFile,
  type AgorPackTeammateFile,
  type AgorPackTeammateSummary,
  type AgorPackUploadFile,
  type Artifact,
  type Board,
  type Branch,
  type DeepReadonly,
  getTeammateConfig,
  hasMinimumRole,
  isTeammate,
  type MCPServer,
  type MCPServerID,
  pluralize,
  type Repo,
  ROLES,
  type Schedule,
  type Session,
  type StagedBlobReadInput,
  type TenantID,
  UPLOAD_VIRTUAL_URL_PREFIX,
  type UploadRef,
  type User,
  type UserID,
  type UserRole,
} from '@agor/core/types';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { getBlobStagingStore, getUploadStagingStore } from '../utils/upload-staging.js';
import {
  agorPackCollectExecutorCommandId,
  runAgorPackExecutorCommand,
} from './agor-pack-executor.js';
import { exportKnowledgeRepository, previewKnowledgeExport } from './knowledge-transfers.js';

export interface AgorPackServiceContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: DeepReadonly<AgorConfig>;
  tenantId: TenantID;
  user: User;
  agorVersion: string;
}

const RECENT_MS = AGOR_PACK.recentSessionDays * 24 * 60 * 60 * 1000;
const BOARD_HIDDEN_WARNING = "You can't view this teammate's board, so it stays out of the pack.";
const USER_ENV_TEMPLATE = /\{\{\s*user\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const UPLOAD_LINK = new RegExp(
  `${UPLOAD_VIRTUAL_URL_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(upl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})`,
  'g'
);

/** A pack blob of this import/export, owned by the caller. */
export function agorPackBlob(
  ctx: Pick<AgorPackServiceContext, 'tenantId' | 'user'>,
  scopeId: string,
  ref: string
): StagedBlobReadInput {
  return {
    tenantId: ctx.tenantId,
    kind: 'agor-pack',
    scopeId,
    createdBy: ctx.user.user_id as UserID,
    ref: ref as UploadRef,
  };
}

function iso(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return new Date(0).toISOString();
  return new Date(value).toISOString();
}

/** Text files are scanned for secrets; binary files (NUL in the head) are not. */
function looksLikeText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0);
}

/**
 * Buffer a stream up to `limit` bytes. Larger streams are drained and only
 * their first chunk is kept (`content` null), enough to tell text from binary.
 */
async function readBounded(
  stream: NodeJS.ReadableStream,
  limit: number
): Promise<{ content: Buffer | null; head: Buffer }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.byteLength;
    if (size > limit) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      return { content: null, head: chunks[0] ?? buffer };
    }
    chunks.push(buffer);
  }
  const content = Buffer.concat(chunks);
  return { content, head: content };
}

function envNamesIn(value: unknown, into: Set<string>): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const match of text.matchAll(USER_ENV_TEMPLATE)) into.add(match[1] as string);
}

function scrubbedJson(path: string, value: unknown): string {
  assertNoSecretsDeep(path, value);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertNoSecrets(path, text);
  return text;
}

const CREDENTIAL_NAME =
  /(api[_-]?key|access[_-]?key|key$|token|secret|passw|pwd|credential|signature|^-*sig$|^-*auth$|authorization)/i;
const REDACTED = '[redacted]';
const isTemplate = (value: string) => value.includes('{{');

/**
 * Drop credentials an MCP server URL carries inline (userinfo, credential-named
 * query parameters). `{{ user.env.X }}` references are kept: they travel by name.
 */
export function sanitizeMcpUrl(url: string): { url: string; changed: boolean } {
  let changed = false;
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i, (whole, scheme, userinfo) => {
    if (isTemplate(userinfo)) return whole;
    changed = true;
    return scheme;
  });
  out = out.replace(/\?([^#]*)/, (whole, query: string) => {
    const parts = query.split('&').map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (!CREDENTIAL_NAME.test(name) || isTemplate(value) || value === '') return part;
      changed = true;
      return `${name}=${REDACTED}`;
    });
    return `?${parts.join('&')}`;
  });
  return { url: out, changed };
}

/** Same for command arguments: `--api-key x` and `--api-key=x` lose their values. */
export function sanitizeMcpArgs(args: readonly string[]): { args: string[]; changed: boolean } {
  let changed = false;
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i] as string;
    const flag = /^(-{1,2}[A-Za-z0-9_.-]+)(=(.*))?$/.exec(arg);
    if (!flag || !CREDENTIAL_NAME.test(flag[1] as string)) continue;
    if (flag[2] !== undefined) {
      if (!isTemplate(flag[3] as string) && flag[3] !== '') {
        out[i] = `${flag[1]}=${REDACTED}`;
        changed = true;
      }
      continue;
    }
    const next = out[i + 1];
    if (next !== undefined && !next.startsWith('-') && !isTemplate(next)) {
      out[i + 1] = REDACTED;
      changed = true;
      i += 1;
    }
  }
  return { args: out, changed };
}

export class AgorPackExporter {
  private readonly branches: BranchRepository;
  private readonly authors = new Map<string, AgorPackAuthor>();

  constructor(private readonly ctx: AgorPackServiceContext) {
    this.branches = new BranchRepository(ctx.db);
  }

  private unit<T>(work: () => Promise<T>): Promise<T> {
    return runWithTenantDatabaseScope(this.ctx.db, this.ctx.tenantId, work);
  }

  async authorOf(userId: string | null | undefined): Promise<AgorPackAuthor> {
    if (!userId) return { name: null, email: null };
    const cached = this.authors.get(userId);
    if (cached) return cached;
    const user = await this.unit(() => new UsersRepository(this.ctx.db).findById(userId));
    const author = { name: user?.name ?? null, email: user?.email ?? null };
    this.authors.set(userId, author);
    return author;
  }

  /** Load a teammate branch the caller may export (`all` + filesystem read). */
  async loadTeammate(branchId: string): Promise<{ branch: Branch; repo: Repo }> {
    const branch = await this.unit(() => this.branches.findById(branchId));
    if (!branch || branch.archived || !isTeammate(branch)) {
      throw new NotFound(`Teammate not found: ${branchId}`);
    }
    // Members move their own teammates (by primary owner); admins can move anyone's.
    if (
      !hasMinimumRole(this.ctx.user.role, ROLES.ADMIN) &&
      (branch.primary_owner_user_id ?? branch.created_by) !== this.ctx.user.user_id
    ) {
      throw new Forbidden(
        `Only the owner of ${getTeammateConfig(branch)?.displayName ?? 'this teammate'} or an admin can export it`
      );
    }
    await this.unit(() =>
      ensureBranchWorkspaceAccess(
        this.branches,
        branch,
        this.ctx.user.user_id,
        this.ctx.user.role as UserRole,
        'all',
        'read',
        this.ctx.config.execution?.allow_superadmin === true
      )
    ).catch((error: unknown) => {
      throw new BadRequest(
        `You need full access to ${getTeammateConfig(branch)?.displayName ?? 'this teammate'} to export it (${error instanceof Error ? error.message : String(error)})`
      );
    });
    const repo = await this.unit(() => new RepoRepository(this.ctx.db).findById(branch.repo_id));
    if (!repo) throw new NotFound('Teammate repository not found');
    return { branch, repo };
  }

  /** Sessions the request selects; archived ones are left out and counted. */
  private async selectSessions(
    branch: Branch,
    mode: AgorPackExportOptions['sessions'],
    includeOthers: boolean,
    excluded: ReadonlySet<string> = new Set()
  ): Promise<{ sessions: Session[]; archived: number }> {
    if (mode === 'none') return { sessions: [], archived: 0 };
    const all = await this.unit(() =>
      new SessionRepository(this.ctx.db).findAll({ branchId: branch.branch_id })
    );
    const since = Date.now() - RECENT_MS;
    const selected = all
      .filter((session) => !excluded.has(session.session_id))
      .filter((session) => includeOthers || session.created_by === this.ctx.user.user_id)
      .filter((session) => mode === 'all' || Date.parse(session.last_updated) >= since);
    return {
      sessions: selected
        .filter((session) => !session.archived)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
      archived: selected.filter((session) => session.archived).length,
    };
  }

  private async referencedMcpServers(
    branch: Branch,
    schedules: Schedule[]
  ): Promise<{
    servers: MCPServer[];
    usedBy: Map<string, Set<string>>;
    channels: { channel_type: string; name: string; mcp: string[]; envNames: string[] }[];
  }> {
    const usedBy = new Map<string, Set<string>>();
    const note = (id: string, use: string) => {
      const set = usedBy.get(id) ?? new Set<string>();
      set.add(use);
      usedBy.set(id, set);
    };
    for (const schedule of schedules) {
      for (const id of schedule.mcp_server_ids ?? []) note(id, `schedule:${schedule.name}`);
    }
    const channels = (
      await this.unit(() => new GatewayChannelRepository(this.ctx.db).findDisplayAll())
    ).filter((channel) => channel.target_branch_id === branch.branch_id);
    for (const channel of channels) {
      for (const id of channel.mcp_server_ids ?? []) note(id, `gateway:${channel.channel_type}`);
    }
    const servers = usedBy.size
      ? await this.unit(() =>
          new MCPServerRepository(this.ctx.db).findByIds([...usedBy.keys()] as MCPServerID[])
        )
      : [];
    return {
      servers,
      usedBy,
      channels: channels.map((channel) => ({
        channel_type: channel.channel_type,
        name: channel.name,
        mcp: channel.mcp_server_ids ?? [],
        envNames: Object.keys(
          ((channel.agentic_config as Record<string, unknown> | null)?.envVars as
            | Record<string, unknown>
            | undefined) ?? {}
        ),
      })),
    };
  }

  private async requirements(
    branch: Branch,
    schedules: Schedule[],
    artifacts: Artifact[],
    sessions: Session[]
  ): Promise<{ requirements: AgorPackRequirements; servers: MCPServer[] }> {
    const { servers, usedBy, channels } = await this.referencedMcpServers(branch, schedules);
    const env = new Map<string, { scope: 'global' | 'session' | null; used_by: Set<string> }>();
    const need = (name: string, use: string) => {
      const entry = env.get(name) ?? { scope: null, used_by: new Set<string>() };
      entry.used_by.add(use);
      env.set(name, entry);
    };
    for (const server of servers) {
      const names = new Set<string>();
      envNamesIn(server.url, names);
      envNamesIn(server.env, names);
      envNamesIn(server.headers, names);
      envNamesIn(server.auth, names);
      for (const name of names) need(name, `mcp:${server.name}`);
    }
    for (const artifact of artifacts) {
      for (const name of artifact.required_env_vars ?? []) need(name, `artifact:${artifact.name}`);
    }
    for (const channel of channels) {
      for (const name of channel.envNames) need(name, `gateway:${channel.channel_type}`);
    }
    const self = await this.unit(() =>
      new UsersRepository(this.ctx.db).findById(this.ctx.user.user_id)
    );
    const ownEnv = (self as { env_vars?: Record<string, { scope?: string }> } | null)?.env_vars;
    for (const [name, meta] of Object.entries(ownEnv ?? {})) {
      need(name, 'user');
      const entry = env.get(name);
      if (entry && (meta?.scope === 'global' || meta?.scope === 'session'))
        entry.scope = meta.scope;
    }
    const tools = new Set<string>();
    for (const session of sessions) tools.add(session.agentic_tool);
    for (const schedule of schedules) tools.add(schedule.agentic_tool_config.agentic_tool);
    return {
      servers,
      requirements: {
        env_vars: [...env.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, entry]) => ({
            name,
            scope: entry.scope,
            used_by: [...entry.used_by].sort(),
          })),
        mcp_servers: servers
          .map((server) => ({
            name: server.name,
            display_name: server.display_name ?? null,
            catalog_entry_name: server.catalog_entry_name ?? null,
            url:
              server.transport === 'stdio' || !server.url ? null : sanitizeMcpUrl(server.url).url,
            custom: !server.catalog_entry_name,
            used_by: [...(usedBy.get(server.mcp_server_id) ?? [])].sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        gateway_channels: channels.map(({ channel_type, name }) => ({ channel_type, name })),
        agentic_tools: [...tools].sort(),
      },
    };
  }

  /** Counts, requirements, and warnings shown before an export starts. */
  async preflight(branchIds: string[]): Promise<AgorPackPreflightTeammate[]> {
    const results: AgorPackPreflightTeammate[] = [];
    for (const branchId of branchIds) {
      const { branch, repo } = await this.loadTeammate(branchId);
      const teammate = getTeammateConfig(branch);
      const everything = await this.unit(() =>
        new SessionRepository(this.ctx.db).findAll({ branchId: branch.branch_id })
      );
      const all = everything.filter((s) => !s.archived);
      const since = Date.now() - RECENT_MS;
      const own = all.filter((s) => s.created_by === this.ctx.user.user_id);
      const others = all.filter((s) => s.created_by !== this.ctx.user.user_id);
      const recent = (list: Session[]) =>
        list.filter((s) => Date.parse(s.last_updated) >= since).length;
      // Same serializer and secret scan as the export: sizes for the history
      // choice, and the sessions it would redact ("may contain passwords").
      const sessionBytes = { own: 0, others: 0, recent_own: 0, recent_others: 0 };
      const flagged: AgorPackFlaggedSession[] = [];
      for (const session of all) {
        const { file, lines, redacted } = await this.serializeSession(session, new Set());
        const bytes =
          Buffer.byteLength(JSON.stringify(file)) +
          lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
        const isOwn = session.created_by === this.ctx.user.user_id;
        const isRecent = Date.parse(session.last_updated) >= since;
        sessionBytes[isOwn ? 'own' : 'others'] += bytes;
        if (isRecent) sessionBytes[isOwn ? 'recent_own' : 'recent_others'] += bytes;
        if (redacted > 0) {
          flagged.push({
            session_id: session.session_id,
            title: session.title ?? null,
            own: isOwn,
            recent: isRecent,
          });
        }
      }
      const schedules = await this.unit(() =>
        new ScheduleRepository(this.ctx.db).findByBranchId(branch.branch_id)
      );
      const { artifacts, archived: archivedArtifacts } = await this.boardArtifacts(branch);
      const boardHidden = Boolean(branch.board_id) && !(await this.viewableBoard(branch));
      const { requirements } = await this.requirements(branch, schedules, artifacts, own);
      const namespaceId = teammate?.kb?.primary_namespace_id;
      const knowledge = namespaceId
        ? await this.unit(() => previewKnowledgeExport(this.ctx.db, namespaceId, this.ctx.user))
        : {
            documents: 0,
            bytes: 0,
            archived: 0,
            privateSkipped: 0,
            outsideLinks: { count: 0, namespaces: [] },
          };
      const environment = this.environment(branch, repo);
      const warnings: string[] = [];
      if (boardHidden) warnings.push(BOARD_HIDDEN_WARNING);
      if (environment.variants.some((variant) => variant.status !== 'ok')) {
        warnings.push("Some environment variants won't run in Agor Cloud as configured.");
      }
      if (requirements.env_vars.length) {
        warnings.push(
          `${pluralize(requirements.env_vars.length, 'environment variable')} ${requirements.env_vars.length === 1 ? 'travels' : 'travel'} by name only; set ${requirements.env_vars.length === 1 ? 'its value' : 'their values'} after import.`
        );
      }
      results.push({
        branch_id: branch.branch_id,
        display_name: teammate?.displayName ?? branch.name,
        local_home: teammate?.localHome === true,
        remote_url: teammate?.localHome ? null : (repo.remote_url ?? null),
        sessions: {
          own: own.length,
          others: others.length,
          recent_own: recent(own),
          recent_others: recent(others),
        },
        session_bytes: sessionBytes,
        other_bytes:
          knowledge.bytes +
          artifacts.reduce(
            (sum, artifact) => sum + Buffer.byteLength(JSON.stringify(artifact.files ?? {})),
            0
          ),
        flagged_sessions: flagged,
        board: Boolean(branch.board_id) && !boardHidden,
        schedules: schedules.length,
        artifacts: artifacts.length,
        knowledge_documents: knowledge.documents,
        knowledge_outside_links: knowledge.outsideLinks,
        archived: {
          sessions: everything.length - all.length,
          knowledge_documents: knowledge.archived,
          artifacts: archivedArtifacts,
          private_knowledge_documents: knowledge.privateSkipped,
        },
        requirements,
        environment,
        switch_over: branch.agor_pack?.switch_over ?? null,
        warnings,
      });
    }
    return results;
  }

  /**
   * One session as it goes into a pack: the session file and its message
   * lines, secret-shaped text redacted (`redacted` counts the values). The
   * preflight runs the same serializer to flag sessions and estimate sizes.
   */
  private async serializeSession(
    session: Session,
    exportedIds: ReadonlySet<string>
  ): Promise<{ file: AgorPackSessionFile; lines: string[]; redacted: number }> {
    const tasks = await this.unit(() =>
      new TaskRepository(this.ctx.db).findAll({ sessionId: session.session_id })
    );
    const file: AgorPackSessionFile = {
      version: 1,
      session: {
        source_session_id: session.session_id,
        title: session.title ?? null,
        description: session.description ?? null,
        agentic_tool: session.agentic_tool,
        model_config: (session.model_config as Record<string, unknown> | undefined) ?? null,
        created_at: iso(session.created_at),
        last_updated: iso(session.last_updated),
        parent_source_session_id:
          session.genealogy?.parent_session_id &&
          exportedIds.has(session.genealogy.parent_session_id)
            ? session.genealogy.parent_session_id
            : null,
        forked_from_source_session_id:
          session.genealogy?.forked_from_session_id &&
          exportedIds.has(session.genealogy.forked_from_session_id)
            ? session.genealogy.forked_from_session_id
            : null,
        originally_by: await this.authorOf(session.created_by),
      },
      tasks: tasks
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((task) => ({
          source_task_id: task.task_id,
          full_prompt: task.full_prompt ?? '',
          status: task.status,
          model: task.model ?? null,
          created_at: iso(task.created_at),
          completed_at: task.completed_at ? iso(task.completed_at) : null,
          duration_ms: typeof task.duration_ms === 'number' ? task.duration_ms : null,
          message_range: (task.message_range as Record<string, unknown> | undefined) ?? null,
        })),
    };
    const scrubbedFile = redactSecretsDeep(file);
    let redacted = scrubbedFile.redacted;
    const messages = await this.unit(() =>
      new MessagesRepository(this.ctx.db).findAll({ sessionId: session.session_id })
    );
    const lines: string[] = [];
    for (const message of messages) {
      const line: AgorPackMessage = {
        source_message_id: message.message_id,
        source_task_id: message.task_id ?? null,
        type: message.type,
        role: message.role,
        index: message.index,
        timestamp: iso(message.timestamp),
        content_preview: message.content_preview ?? '',
        content: message.content,
        tool_uses: (message.tool_uses as unknown[] | undefined) ?? null,
        parent_tool_use_id: message.parent_tool_use_id ?? null,
        // Only display metadata travels; runtime/recovery bookkeeping stays behind.
        metadata: message.metadata
          ? {
              ...(message.metadata.model ? { model: message.metadata.model } : {}),
              ...(message.metadata.tokens ? { tokens: message.metadata.tokens } : {}),
            }
          : null,
      };
      const scrubbed = redactSecretsDeep(line);
      redacted += scrubbed.redacted;
      lines.push(JSON.stringify(scrubbed.value));
    }
    return { file: { ...scrubbedFile.value, redacted_values: redacted }, lines, redacted };
  }

  private environment(branch: Branch, repo: Repo): AgorPackTeammateSummary['environment'] {
    return {
      variant: branch.environment_variant ?? repo.environment?.default ?? null,
      variants: classifyEnvironmentVariants(repo.environment),
    };
  }

  /**
   * The teammate board when the exporter may view it (same rule as the boards
   * service: admins, or `board.view`). Null when there is none or it is hidden.
   */
  private async viewableBoard(branch: Branch): Promise<Board | null> {
    if (!branch.board_id) return null;
    return this.unit(async () => {
      const boards = new BoardRepository(this.ctx.db);
      const board = await boards.findById(branch.board_id as string);
      if (!board) return null;
      if (hasMinimumRole(this.ctx.user.role, ROLES.ADMIN)) return board;
      return (await boards.canViewResolved(board, this.ctx.user.user_id)) ? board : null;
    });
  }

  /**
   * Artifacts referenced by the teammate board that the exporter can see;
   * archived ones are left out and counted.
   */
  private async boardArtifacts(
    branch: Branch
  ): Promise<{ artifacts: Artifact[]; archived: number }> {
    const board = await this.viewableBoard(branch);
    const ids = Object.values(board?.objects ?? {}).flatMap((object) =>
      object.type === 'artifact' ? [object.artifact_id] : []
    );
    if (!ids.length) return { artifacts: [], archived: 0 };
    const artifacts = new ArtifactRepository(this.ctx.db);
    const visible = await this.unit(() =>
      artifacts.findBoardReferenceVisibleIds(ids, this.ctx.user.user_id)
    );
    const rows: Artifact[] = [];
    let archived = 0;
    for (const id of ids) {
      if (!visible.has(id)) continue;
      const row = await this.unit(() => artifacts.findById(id));
      if (row?.archived) archived += 1;
      else if (row) rows.push(row);
    }
    return { artifacts: rows, archived };
  }

  /**
   * Stream the pack into `writer` and finish it. The caller owns `writer.output`
   * (pipe it before calling) and aborts the writer on error.
   */
  /**
   * Every teammate of an export, checked (exists, owner or admin, full
   * access, repo). Run it before any streaming starts so a refusal is a clean
   * HTTP error, not an aborted stream.
   */
  async authorize(branchIds: string[]): Promise<Array<{ branch: Branch; repo: Repo }>> {
    const loaded = [];
    for (const id of new Set(branchIds)) loaded.push(await this.loadTeammate(id));
    return loaded;
  }

  async export(
    request: AgorPackExportOptions,
    writer: AgorPackWriter,
    authorized?: Array<{ branch: Branch; repo: Repo }>
  ): Promise<AgorPackManifest> {
    const sections = new Set(request.sections);
    const loaded = authorized ?? (await this.authorize(request.branch_ids));
    const teammates: AgorPackTeammateSummary[] = [];
    for (const [index, { branch, repo }] of loaded.entries()) {
      teammates.push(
        await this.exportTeammate(
          `t${String(index + 1).padStart(2, '0')}`,
          branch,
          repo,
          request,
          sections,
          writer
        )
      );
    }
    const self = await this.authorOf(this.ctx.user.user_id);
    return writer.finish(({ entries, content_sha256 }) => ({
      format: AGOR_PACK.format,
      version: AGOR_PACK.version,
      pack_id: generateId(),
      created_at: new Date().toISOString(),
      source: {
        agor_version: this.ctx.agorVersion,
        instance_label: null,
        exported_by: { user_id: this.ctx.user.user_id, email: self.email, name: self.name },
      },
      options: {
        sections: [...sections].sort() as AgorPackManifest['options']['sections'],
        sessions: request.sessions,
        include_others_sessions: request.include_others_sessions,
      },
      teammates,
      entries,
      content_sha256,
    }));
  }

  private async exportTeammate(
    key: string,
    branch: Branch,
    repo: Repo,
    request: AgorPackExportOptions,
    sections: Set<string>,
    writer: AgorPackWriter
  ): Promise<AgorPackTeammateSummary> {
    const teammate = getTeammateConfig(branch);
    if (!teammate) throw new BadRequest('Not a teammate');
    const path = (relative: string) => teammatePackPath(key, relative);
    const warnings: string[] = [];
    const localHome = teammate.localHome === true;
    const summary: AgorPackTeammateSummary['sections'] = {
      board: null,
      knowledge: null,
      artifacts: null,
      schedules: null,
      claude_memory: null,
      uploads: null,
      sessions: null,
      git: null,
    };

    // Board (+ artifacts referenced by it). Archived artifacts stay behind.
    const boardArtifacts = await this.boardArtifacts(branch);
    const artifacts = sections.has('artifacts') ? boardArtifacts.artifacts : [];
    const archivedSkipped: AgorPackArchivedSkips = {
      sessions: 0,
      knowledge_documents: 0,
      artifacts: sections.has('board') || sections.has('artifacts') ? boardArtifacts.archived : 0,
    };
    const archivedArtifactIds = new Set<string>();
    const board = sections.has('board') ? await this.viewableBoard(branch) : null;
    if (sections.has('board') && branch.board_id && !board) warnings.push(BOARD_HIDDEN_WARNING);
    if (board) {
      const boards = new BoardRepository(this.ctx.db);
      const blob = await this.unit(() => boards.toBlob(board.board_id));
      const placement = await this.unit(() =>
        new BoardObjectRepository(this.ctx.db).findByBranchId(branch.branch_id)
      );
      const artifactObjects: Record<string, string> = {};
      const sequenceById = new Map(
        artifacts.map((artifact, i) => [artifact.artifact_id, packSequence(i)])
      );
      if (boardArtifacts.archived) {
        const repo = new ArtifactRepository(this.ctx.db);
        for (const object of Object.values(blob.objects ?? {})) {
          if (object.type !== 'artifact') continue;
          const row = await this.unit(() => repo.findById(object.artifact_id));
          if (row?.archived) archivedArtifactIds.add(object.artifact_id);
        }
      }
      const objects: NonNullable<typeof blob.objects> = {};
      for (const [objectId, object] of Object.entries(blob.objects ?? {})) {
        if (object.type === 'artifact' && archivedArtifactIds.has(object.artifact_id)) continue;
        objects[objectId] = object;
        if (object.type !== 'artifact') continue;
        const sequence = sequenceById.get(object.artifact_id);
        if (sequence) artifactObjects[objectId] = sequence;
      }
      blob.objects = objects;
      const file: AgorPackBoardFile = {
        version: 1,
        board: { ...blob, version: 1 } as unknown as Record<string, unknown>,
        placement: placement
          ? { zone_object_id: placement.zone_id ?? null, position: placement.position }
          : null,
        artifact_objects: artifactObjects,
      };
      writer.addBuffer(path('board.json'), scrubbedJson(path('board.json'), file));
      summary.board = { objects: Object.keys(blob.objects ?? {}).length };
    }
    if (sections.has('artifacts')) {
      for (const [index, artifact] of artifacts.entries()) {
        const entry = path(`artifacts/${packSequence(index)}.json`);
        const file: AgorPackArtifactFile = {
          version: 1,
          name: artifact.name,
          description: artifact.description ?? null,
          template: artifact.template,
          files: artifact.files ?? null,
          dependencies: artifact.dependencies ?? null,
          entry: artifact.entry ?? null,
          sandpack_config:
            (artifact.sandpack_config as Record<string, unknown> | undefined) ?? null,
          required_env_vars: artifact.required_env_vars ?? null,
          agor_runtime: (artifact.agor_runtime as Record<string, unknown> | undefined) ?? null,
          had_agor_grants: Boolean(artifact.agor_grants),
          originally_by: await this.authorOf(artifact.created_by),
        };
        writer.addBuffer(entry, scrubbedJson(entry, file));
        if (artifact.agor_grants) {
          warnings.push(`Artifact "${artifact.name}" had Agor grants; they are not exported.`);
        }
      }
      summary.artifacts = artifacts.length;
    }

    // Knowledge (teammate memory namespace).
    const namespaceId = teammate.kb?.primary_namespace_id;
    const namespace =
      sections.has('knowledge') && namespaceId
        ? await this.unit(() => new KnowledgeNamespaceRepository(this.ctx.db).findById(namespaceId))
        : null;
    if (namespace?.archived) warnings.push('Knowledge is archived and was skipped.');
    if (sections.has('knowledge') && namespaceId && namespace && !namespace.archived) {
      archivedSkipped.knowledge_documents = await this.unit(() =>
        new KnowledgeTransferRepository(this.ctx.db).archivedCount(namespaceId)
      );
      const kb = await this.unit(() =>
        exportKnowledgeRepository(this.ctx.db, namespaceId, {
          user: this.ctx.user,
          includeHistory: sections.has('knowledge_history'),
          authorOf: (id) => this.authorOf(id),
        })
      );
      if (kb.privateSkipped) archivedSkipped.private_knowledge_documents = kb.privateSkipped;
      for (const file of kb.files) {
        const entry = path(`knowledge/${file.path}`);
        assertNoSecrets(entry, file.content);
        writer.addBuffer(entry, file.content);
      }
      if (kb.history && kb.history.documents.length > 0) {
        writer.addBuffer(
          path('knowledge/history.json'),
          scrubbedJson(path('knowledge/history.json'), kb.history)
        );
      }
      summary.knowledge = {
        documents: kb.documents,
        history_versions: kb.historyVersions,
        outside_links: kb.outsideLinks,
      };
    }

    // Schedules.
    const schedules = await this.unit(() =>
      new ScheduleRepository(this.ctx.db).findByBranchId(branch.branch_id)
    );
    const { sessions, archived: archivedSessions } = await this.selectSessions(
      branch,
      request.sessions,
      request.include_others_sessions,
      new Set(request.exclude_session_ids)
    );
    archivedSkipped.sessions = archivedSessions;
    const { requirements, servers } = await this.requirements(
      branch,
      schedules,
      artifacts,
      sessions
    );
    const serverNames = new Map<string, string>(
      servers.map((server) => [server.mcp_server_id as string, server.name])
    );
    if (sections.has('schedules')) {
      const presets = new AgenticToolPresetRepository(this.ctx.db);
      const dtos: AgorPackSchedule[] = [];
      for (const schedule of schedules) {
        const {
          preset_id: presetId,
          configuration_reference: _reference,
          ...inline
        } = schedule.agentic_tool_config as unknown as Record<string, unknown>;
        const preset = presetId ? await this.unit(() => presets.findById(String(presetId))) : null;
        dtos.push({
          name: schedule.name,
          description: schedule.description ?? null,
          cron_expression: schedule.cron_expression,
          timezone_mode: schedule.timezone_mode,
          timezone: schedule.timezone ?? null,
          prompt: schedule.prompt,
          agentic_tool_config: inline,
          preset_name: preset?.name ?? null,
          allow_concurrent_runs: schedule.allow_concurrent_runs,
          retention: schedule.retention,
          mcp_server_names: (schedule.mcp_server_ids ?? []).flatMap((id) => {
            const name = serverNames.get(id);
            return name ? [name] : [];
          }),
          was_enabled: schedule.enabled,
          originally_by: await this.authorOf(schedule.created_by),
        });
      }
      writer.addBuffer(
        path('schedules.json'),
        scrubbedJson(path('schedules.json'), { version: 1, schedules: dtos })
      );
      summary.schedules = dtos.length;
    }

    // Sessions (+ uploads referenced from them).
    const uploadRefs = new Map<string, string>();
    if (sessions.length > 0) {
      let messageCount = 0;
      let redacted = 0;
      let flagged = 0;
      const exportedIds = new Set(sessions.map((session) => session.session_id as string));
      for (const [index, session] of sessions.entries()) {
        const sequence = packSequence(index);
        const {
          file,
          lines,
          redacted: sessionRedacted,
        } = await this.serializeSession(session, exportedIds);
        for (const text of lines) {
          for (const match of text.matchAll(UPLOAD_LINK)) {
            uploadRefs.set(match[1] as string, session.session_id);
          }
        }
        messageCount += lines.length;
        redacted += sessionRedacted;
        if (sessionRedacted > 0) flagged += 1;
        writer.addBuffer(path(`sessions/${sequence}.json`), `${JSON.stringify(file, null, 2)}\n`);
        writer.addBuffer(
          path(`sessions/${sequence}.messages.jsonl`),
          lines.length ? `${lines.join('\n')}\n` : ''
        );
      }
      summary.sessions = {
        mode: request.sessions,
        count: sessions.length,
        messages: messageCount,
        others_included: request.include_others_sessions,
        redacted_values: redacted,
        flagged,
      };
      if (redacted > 0) {
        warnings.push(
          `${pluralize(redacted, 'secret-shaped value')} in session history ${redacted === 1 ? 'was' : 'were'} redacted.`
        );
      }
    } else if (request.sessions !== 'none') {
      summary.sessions = {
        mode: request.sessions,
        count: 0,
        messages: 0,
        others_included: request.include_others_sessions,
        redacted_values: 0,
      };
    }

    if (sections.has('uploads')) {
      const uploads = new UploadRepository(this.ctx.db);
      const store = getUploadStagingStore();
      let count = 0;
      let bytes = 0;
      for (const [ref, sessionId] of [...uploadRefs.entries()].sort()) {
        const row = await this.unit(() => uploads.findOwned(this.ctx.tenantId, ref as UploadRef));
        if (row?.status !== 'active' || row.sessionId !== sessionId) continue;
        let stream: NodeJS.ReadableStream;
        try {
          stream = await store.read({
            tenantId: this.ctx.tenantId,
            sessionId: row.sessionId,
            branchId: row.branchId,
            ref: row.ref,
          });
        } catch {
          warnings.push(`Attachment ${row.displayName} is no longer available and was skipped.`);
          continue;
        }
        // Attachments are user files: a text one carrying a token stays behind,
        // and so does one too large to scan.
        const { content, head } = await readBounded(stream, AGOR_PACK.maxTextEntryBytes);
        if (content === null && looksLikeText(head)) {
          warnings.push(
            `Attachment ${row.displayName} is too large to check for secrets and was skipped.`
          );
          continue;
        }
        if (
          content &&
          looksLikeText(content) &&
          scanForSecrets(content.toString('utf8')).length > 0
        ) {
          warnings.push(
            `Attachment ${row.displayName} looks like it contains a secret and was skipped.`
          );
          continue;
        }
        if (content === null) {
          stream = await store.read({
            tenantId: this.ctx.tenantId,
            sessionId: row.sessionId,
            branchId: row.branchId,
            ref: row.ref,
          });
        }
        const meta: AgorPackUploadFile = {
          version: 1,
          ref: row.ref,
          source_session_id: row.sessionId,
          name: row.displayName,
          mime_type: row.mimeType,
          size: row.size,
          created_at: iso(row.createdAt),
        };
        if (content)
          writer.addBuffer(path(`uploads/${row.ref}.data`), content, { compress: false });
        else
          await writer.addStream(path(`uploads/${row.ref}.data`), stream as never, {
            compress: false,
          });
        writer.addJson(path(`uploads/${row.ref}.json`), meta);
        count += 1;
        bytes += row.size;
      }
      summary.uploads = { count, bytes };
    }

    // Git history, dirty files, and Claude memory via the executor.
    const exportId = generateId();
    const collected = await runAgorPackExecutorCommand(this.ctx, {
      command: 'branch.pack.collect',
      commandId: agorPackCollectExecutorCommandId(exportId),
      branch,
      params: { exportId, includeClaudeMemory: sections.has('claude_memory') },
    });
    await this.copyFragment(key, exportId, String(collected.fragmentRef), writer);
    summary.git = collected.git as AgorPackTeammateSummary['sections']['git'];
    summary.claude_memory =
      (collected.claudeMemory as AgorPackTeammateSummary['sections']['claude_memory']) ?? null;
    if (!localHome && summary.git && summary.git.unpushed_commits > 0) {
      warnings.push(
        `${pluralize(summary.git.unpushed_commits, 'unpushed commit')} ${summary.git.unpushed_commits === 1 ? 'travels' : 'travel'} as a git bundle; pushing first is more reliable.`
      );
    }

    // Teammate definition last: it records the custom MCP servers and slug.
    const custom = servers.filter((server) => !server.catalog_entry_name);
    const teammateFile: AgorPackTeammateFile = {
      version: 1,
      teammate: {
        displayName: teammate.displayName,
        ...(teammate.emoji ? { emoji: teammate.emoji } : {}),
        ...(teammate.frameworkRepo ? { frameworkRepo: teammate.frameworkRepo } : {}),
        ...(teammate.frameworkVersion ? { frameworkVersion: teammate.frameworkVersion } : {}),
      },
      branch: {
        name: branch.name,
        ref: branch.ref,
        notes: branch.notes ?? null,
        environment_variant: branch.environment_variant ?? null,
        custom_context: null,
      },
      repo: {
        slug: repo.slug,
        name: repo.name ?? null,
        remote_url: localHome ? null : (repo.remote_url ?? null),
        default_branch: repo.default_branch ?? null,
        local_home: localHome,
        environment: repo.environment ?? null,
      },
      mcp_servers: custom.map((server) => {
        const url = server.url ? sanitizeMcpUrl(server.url) : null;
        const args = server.args ? sanitizeMcpArgs(server.args) : null;
        if (url?.changed || args?.changed) {
          warnings.push(
            `MCP server "${server.name}" had credentials in its URL or arguments; they were removed. Re-enter them after import.`
          );
        }
        return {
          name: server.name,
          display_name: server.display_name ?? null,
          description: server.description ?? null,
          transport: server.transport,
          url: url?.url ?? null,
          command: server.command ?? null,
          args: args?.args ?? null,
          env_names: Object.keys(server.env ?? {}),
          header_names: Object.keys(server.headers ?? {}),
        };
      }),
      claude_project_slug: claudeProjectSlug(branch.path),
      originally_by: await this.authorOf(branch.created_by),
    };
    writer.addBuffer(path('teammate.json'), scrubbedJson(path('teammate.json'), teammateFile));
    if (custom.length) {
      warnings.push(
        `${pluralize(custom.length, 'custom MCP server')} will be recreated disabled, without credentials.`
      );
    }

    summary.archived_skipped = archivedSkipped;
    const environment = this.environment(branch, repo);
    if (environment.variants.some((variant) => variant.status === 'wont_run_in_cloud')) {
      warnings.push("Some environment variants won't run in Agor Cloud as configured.");
    }
    return {
      key,
      display_name: teammate.displayName,
      emoji: teammate.emoji ?? null,
      source_branch_id: branch.branch_id,
      branch_name: branch.name,
      repo: {
        slug: repo.slug,
        remote_url: localHome ? null : (repo.remote_url ?? null),
        local_home: localHome,
      },
      sections: summary,
      requirements,
      environment,
      warnings,
    };
  }

  /** Re-key the executor's fragment entries into this teammate's folder. */
  private async copyFragment(
    key: string,
    exportId: string,
    ref: string,
    writer: AgorPackWriter
  ): Promise<void> {
    const store = getBlobStagingStore();
    const owner = agorPackBlob(this.ctx, exportId, ref);
    try {
      const meta = await store.inspect(owner);
      await forEachPackFragmentEntry(
        {
          size: meta.size,
          readRange: async (start, end) =>
            (await store.read({ ...owner, offset: start, length: end - start })) as never,
        },
        async (entry) => {
          const prefix = teammatePackPath(AGOR_PACK_FRAGMENT_KEY, '');
          if (!entry.path.startsWith(prefix)) return;
          await writer.addStream(
            teammatePackPath(key, entry.path.slice(prefix.length)),
            await entry.open(),
            { mode: entry.mode || 0o644, compress: !entry.path.endsWith('.bundle') }
          );
        }
      );
    } finally {
      await store.delete(owner).catch(() => undefined);
    }
  }
}
