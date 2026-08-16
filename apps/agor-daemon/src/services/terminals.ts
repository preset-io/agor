/**
 * Process-affine web terminal service.
 *
 * A terminal attachment is owned by the daemon boot that created it and is
 * scoped to one tenant, user, and branch. PTY bytes never leave that daemon.
 * There is deliberately no durable terminal record and no live-PTY resume or
 * migration protocol. Zellij may preserve the shell on the same runtime, but
 * that is independent from Agor's ephemeral transport attachment.
 */

import { createHash, randomUUID } from 'node:crypto';
import { type AgorConfig, createUserProcessEnvironment } from '@agor/core/config';
import {
  BranchRepository,
  getCurrentTenantId,
  RepoRepository,
  runWithTenantDatabaseScope,
  shortId,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  BranchID,
  TerminalAllocatedEvent,
  UserID,
} from '@agor/core/types';
import {
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  UnixUserNotFoundError,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import {
  TERMINAL_REQUEST_JOIN_CHANNEL,
  type TerminalRequestConnection,
} from '../terminal-socket-connection.js';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';
import { hasBranchPermission } from '../utils/branch-authorization.js';
import { resolveOwnerHomeStore } from '../utils/sandbox-context.js';
import { generateScopedServiceToken, spawnExecutorFireAndForget } from '../utils/spawn-executor.js';

const TERMINAL_EXECUTOR_TOKEN_TTL = '30d';

export interface CreateTerminalData {
  rows?: number;
  cols?: number;
  /** Required at runtime. Kept optional in the transport type for a clean 400. */
  branchId?: BranchID;
  ensureCliSessionId?: string;
}

export interface TerminalAttachment {
  terminalId: string;
  userId: UserID;
  branchId: BranchID;
  channel: string;
  sessionName: string;
  ownerId: string;
  ownerBootId: string;
  isNew: boolean;
  branchName: string;
  ready: boolean;
}

interface OwnedTerminal extends TerminalAttachment {
  tenantId: string;
  startedAt: Date;
}

/**
 * Trusted identity carried by a terminal executor capability.
 *
 * The Socket.IO boundary uses this to prove that a capability still names a
 * live attachment owned by this daemon boot. It is deliberately narrower than
 * {@link OwnedTerminal}: callers never need PTY-adjacent state to authorize an
 * executor socket.
 */
export interface TerminalAttachmentIdentity {
  terminalId: string;
  tenantId: string;
  userId: string;
  branchId: string;
  ownerBootId: string;
}

/** Stable Zellij shell identity. It is branch-scoped, unlike the old per-user session. */
export function buildZellijSessionName(
  tenantId: string,
  userId: UserID,
  branchId: BranchID
): string {
  return `agor-${createHash('sha256')
    .update(`${tenantId}:${userId}:${branchId}`)
    .digest('hex')
    .slice(0, 16)}`;
}

/** Kept as display-only compatibility for callers/tests; no longer a routing identity. */
export function buildBranchShellTabName(branch: Pick<Branch, 'branch_id' | 'name'>): string {
  return `${branch.name} · ${shortId(branch.branch_id)}`;
}

export function terminalChannelName(tenantId: string, userId: string, terminalId: string): string {
  return `tenant/${tenantId}/user/${userId}/terminal/${terminalId}`;
}

function terminalRequestAllocation(terminal: TerminalAttachment): TerminalAllocatedEvent {
  return {
    userId: terminal.userId,
    terminalId: terminal.terminalId,
    branchId: terminal.branchId,
  };
}

export class TerminalsService {
  private readonly terminals = new Map<string, OwnedTerminal>();
  private readonly terminalByScope = new Map<string, string>();
  private readonly starting = new Map<string, Promise<void>>();

  constructor(
    private readonly app: Application,
    private readonly db: TenantScopeAwareDatabase
  ) {
    const events = this.app as unknown as import('node:events').EventEmitter;
    events.on('terminal:ready', (data: { terminalId?: string; userId?: string }) => {
      if (data.terminalId && data.userId) this.handleExecutorReady(data.terminalId, data.userId);
    });
    events.on(
      'terminal:error',
      (data: { terminalId?: string; userId?: string; message?: string }) => {
        if (data.terminalId && data.userId) {
          this.handleExecutorError(data.terminalId, data.userId, data.message);
        }
      }
    );
    events.on(
      'terminal:exit',
      (data: { terminalId?: string; userId?: string; exitCode?: number; signal?: number }) => {
        if (data.terminalId && data.userId) {
          this.handleExecutorExit(data.terminalId, data.userId, data.exitCode, data.signal);
        }
      }
    );
    events.on('terminal:close-branch', (data: { tenantId?: string; branchId?: string }) => {
      if (data.tenantId && data.branchId) this.closeBranch(data.tenantId, data.branchId);
    });
  }

  private withTenantDatabase<T>(work: (tenantDb: TenantScopedDatabase) => Promise<T>): Promise<T> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for terminal database access');
    return runWithTenantDatabaseScope(this.db, tenantId, work);
  }

  async create(
    data: CreateTerminalData,
    params?: AuthenticatedParams
  ): Promise<TerminalAttachment> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for terminal creation');
    if (data.ensureCliSessionId !== undefined) {
      throw new BadRequest(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
    }
    if (params?.provider !== 'socketio') {
      throw new BadRequest('Web terminals must be created over the owning Socket.IO connection.');
    }
    const joinRequestingSocket = (params.connection as TerminalRequestConnection | undefined)?.[
      TERMINAL_REQUEST_JOIN_CHANNEL
    ];
    if (!joinRequestingSocket) {
      throw new BadRequest('The owning Socket.IO connection cannot subscribe to this terminal.');
    }
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) throw new Forbidden('Authentication required to open terminals');
    const userRole = params?.user?.role;
    if (!data.branchId) throw new BadRequest('branchId is required to open a terminal');

    const config = this.app.get('config');
    const branch = await this.withTenantDatabase((tenantDb) =>
      new BranchRepository(tenantDb).findById(data.branchId!)
    );
    if (!branch) throw new BadRequest(`Branch not found: ${data.branchId}`);
    if (branch.archived) throw new BadRequest(`Branch is archived: ${branch.name}`);

    if (config.execution?.branch_rbac === true) {
      await this.withTenantDatabase(async (tenantDb) => {
        const branchRepo = new BranchRepository(tenantDb);
        const isOwner = await branchRepo.isOwner(branch.branch_id, userId);
        const permission = await branchRepo.resolveUserPermission(branch, userId);
        if (
          !hasBranchPermission(
            branch,
            userId,
            isOwner,
            'session',
            userRole,
            config.execution?.allow_superadmin === true,
            permission
          )
        ) {
          throw new Forbidden(
            `You need 'session' permission on branch ${branch.name} to open a terminal there.`
          );
        }
      });
    }

    const scopeKey = `${tenantId}:${userId}:${branch.branch_id}`;
    const pending = this.starting.get(scopeKey);
    if (pending) {
      await pending;
      return this.create(data, params);
    }
    const existingId = this.terminalByScope.get(scopeKey);
    const existing = existingId ? this.terminals.get(existingId) : undefined;
    if (existing) {
      const joined = await joinRequestingSocket(
        existing.channel,
        terminalRequestAllocation(existing)
      );
      if (!joined) throw new BadRequest('The owning Socket.IO connection disconnected.');
      return { ...existing, isNew: false };
    }

    let release!: () => void;
    const reservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.starting.set(scopeKey, reservation);
    try {
      return await this.spawnTerminal({
        tenantId,
        userId,
        branch,
        data,
        config,
        scopeKey,
        joinRequestingSocket,
      });
    } finally {
      if (this.starting.get(scopeKey) === reservation) this.starting.delete(scopeKey);
      release();
    }
  }

  private async spawnTerminal(args: {
    tenantId: string;
    userId: UserID;
    branch: Branch;
    data: CreateTerminalData;
    config: AgorConfig;
    scopeKey: string;
    joinRequestingSocket: (channel: string, allocation: TerminalAllocatedEvent) => Promise<boolean>;
  }): Promise<TerminalAttachment> {
    const { tenantId, userId, branch, data, config, scopeKey, joinRequestingSocket } = args;
    const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
    const user = await this.withTenantDatabase((tenantDb) =>
      new UsersRepository(tenantDb).findById(userId)
    );
    const impersonation = resolveUnixUserForImpersonation({
      mode: unixUserMode as UnixUserMode,
      userUnixUsername: user?.unix_username ?? null,
      executorUnixUser: config.execution?.executor_unix_user,
    });
    try {
      validateResolvedUnixUser(unixUserMode as UnixUserMode, impersonation.unixUser);
    } catch (error) {
      if (error instanceof UnixUserNotFoundError) throw new Error(error.message);
      throw error;
    }

    const executorEnv = await this.withTenantDatabase((tenantDb) =>
      createUserProcessEnvironment(userId, tenantDb, undefined, !!impersonation.unixUser)
    );

    // Sandbox mount context for the terminal. The OWNER is the terminal user
    // (they opened the shell), so the per-user home overlay + RBAC branch mount
    // key off `userId` — unlike prompts, which key off session.created_by.
    const sandboxCfg = config.execution?.sandbox;
    const rbacOn = config.execution?.branch_rbac === true;
    let sandboxHomeStore: string | undefined;
    let sandboxBaseRepoPath: string | undefined;
    let sessionOwnerBranchAccess: 'write' | 'read' | 'none' = 'write';
    if (sandboxCfg?.enabled === true) {
      if (branch.storage_mode !== 'clone' && branch.repo_id) {
        sandboxBaseRepoPath = await this.withTenantDatabase((tenantDb) =>
          new RepoRepository(tenantDb)
            .findById(branch.repo_id)
            .then((r) => r?.local_path ?? undefined)
        );
      }
      if (rbacOn) {
        const access = await this.withTenantDatabase((tenantDb) =>
          new BranchRepository(tenantDb).resolveUserAccess(branch, userId)
        );
        sessionOwnerBranchAccess =
          access.fs_access === 'write' ? 'write' : access.fs_access === 'read' ? 'read' : 'none';
        if (sessionOwnerBranchAccess === 'none') {
          throw new Forbidden(
            'You have no filesystem access to this branch; cannot open a sandboxed terminal on it.'
          );
        }
      }
      if (sandboxCfg.home_mode === 'per_user') {
        sandboxHomeStore = resolveOwnerHomeStore({
          tenantId,
          ownerUserId: userId,
          filesystemHome: user?.filesystem_home,
        });
      }
    }
    const identity = this.app.get('distributedWorkIdentity') ?? {
      instanceId: 'daemon',
      bootId: `process-${process.pid}`,
    };
    const terminalId = randomUUID();
    const channel = terminalChannelName(tenantId, userId, terminalId);
    const sessionName = buildZellijSessionName(tenantId, userId, branch.branch_id);
    const terminal: OwnedTerminal = {
      terminalId,
      tenantId,
      userId,
      branchId: branch.branch_id,
      branchName: branch.name,
      channel,
      sessionName,
      ownerId: identity.instanceId,
      ownerBootId: identity.bootId,
      isNew: true,
      ready: false,
      startedAt: new Date(),
    };

    const token = generateScopedServiceToken(
      this.app,
      {
        terminal_user_id: userId,
        terminal_id: terminalId,
        terminal_branch_id: branch.branch_id,
        terminal_owner_boot_id: identity.bootId,
      },
      TERMINAL_EXECUTOR_TOKEN_TTL
    );
    const daemonUrl = `http://127.0.0.1:${config.daemon?.port || 3030}`;

    this.terminals.set(terminalId, terminal);
    this.terminalByScope.set(scopeKey, terminalId);
    try {
      // The browser and executor use different Socket.IO connections. Join the
      // authenticated requester before the executor can emit ready/error/exit,
      // otherwise a fast optional-runtime failure can be lost permanently.
      const joined = await joinRequestingSocket(channel, terminalRequestAllocation(terminal));
      if (!joined) throw new BadRequest('The owning Socket.IO connection disconnected.');

      spawnExecutorFireAndForget(
        {
          command: 'zellij.attach',
          sessionToken: token,
          daemonUrl,
          params: {
            userId,
            terminalId,
            channel,
            sessionName,
            cwd: branch.path,
            cols: data.cols || 160,
            rows: data.rows || 40,
            // Sandbox mount context (consumed in spawn-executor → buildSandboxWrap).
            // Undefined when the sandbox / per_user home is off.
            sandboxHomeStore,
            sandboxBaseRepoPath,
            sessionOwnerBranchAccess,
          },
        },
        {
          logPrefix: `[TerminalsService.executor ${shortId(userId)}/${shortId(terminalId)}]`,
          asUser: impersonation.unixUser || undefined,
          env: executorEnv,
          templateVariables: {
            unix_user: impersonation.reportedUnixUser || undefined,
            executor_type: 'shell',
          },
          onExit: () => this.handleExecutorExit(terminalId, userId),
        }
      );
      return terminal;
    } catch (error) {
      // No executor owns this attachment when the subscription/start boundary
      // fails, so remove the reservation without broadcasting shutdown.
      this.deleteTerminal(terminal);
      throw error;
    }
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<{ closed: boolean }> {
    const userId = params?.user?.user_id;
    const tenantId = getCurrentTenantId();
    if (!userId || !tenantId) throw new Forbidden('Authentication required');
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.userId !== userId || terminal.tenantId !== tenantId) {
      return { closed: false };
    }
    this.stopTerminal(terminal);
    return { closed: true };
  }

  /**
   * Synchronous process-local fence for executor joins and events.
   *
   * A signed capability proves what an executor was allowed to own when it
   * was minted. This registry proves that attachment is still live now. Both
   * are required: terminal capabilities intentionally outlive short executor
   * reconnects, while removal/archive must revoke them immediately.
   */
  matchesOwnedAttachment(identity: TerminalAttachmentIdentity): boolean {
    const terminal = this.terminals.get(identity.terminalId);
    return (
      terminal?.tenantId === identity.tenantId &&
      terminal.userId === identity.userId &&
      terminal.branchId === identity.branchId &&
      terminal.ownerBootId === identity.ownerBootId
    );
  }

  cleanup(): void {
    for (const terminal of [...this.terminals.values()]) this.stopTerminal(terminal);
    this.starting.clear();
  }

  closeBranch(tenantId: string, branchId: string): void {
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.tenantId === tenantId && terminal.branchId === branchId) {
        this.stopTerminal(terminal);
      }
    }
  }

  private stopTerminal(terminal: OwnedTerminal): void {
    this.retireTerminal(terminal, 0);
  }

  private retireTerminal(terminal: OwnedTerminal, exitCode: number, signal?: number): void {
    this.app.io?.local.to(terminal.channel).emit('terminal:exit', {
      terminalId: terminal.terminalId,
      userId: terminal.userId,
      exitCode,
      ...(signal === undefined ? {} : { signal }),
    });
    this.app.emit('terminal:shutdown-local', {
      terminalId: terminal.terminalId,
      userId: terminal.userId,
    });
    this.deleteTerminal(terminal);
  }

  handleExecutorReady(terminalId: string, userId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.userId !== userId) return;
    terminal.ready = true;
    this.app.io?.local.to(terminal.channel).emit('terminal:ready', { terminalId, userId });
  }

  handleExecutorError(terminalId: string, userId: string, message?: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.userId !== userId) return;
    terminal.ready = false;
    this.app.io?.local.to(terminal.channel).emit('terminal:error', { terminalId, userId, message });
  }

  handleExecutorExit(terminalId: string, userId: string, exitCode = 0, signal?: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.userId !== userId) return;
    this.retireTerminal(terminal, exitCode, signal);
    console.log(
      `[TerminalsService] terminal attachment exited user=${shortId(userId)} terminal=${shortId(terminalId)}`
    );
  }

  private deleteTerminal(terminal: OwnedTerminal): void {
    this.terminals.delete(terminal.terminalId);
    const scopeKey = `${terminal.tenantId}:${terminal.userId}:${terminal.branchId}`;
    if (this.terminalByScope.get(scopeKey) === terminal.terminalId) {
      this.terminalByScope.delete(scopeKey);
    }
  }
}
