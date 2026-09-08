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
  runWithTenantDatabaseTransaction,
  shortId,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Branch,
  BranchID,
  TerminalAllocatedEvent,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { resolveDelegatedHomeKey, type UnixUserMode } from '@agor/core/unix';
import {
  LOCAL_AUTHORIZATION_INVALIDATION_EVENT,
  terminalChannelName,
} from '../realtime/routing.js';
import {
  TERMINAL_REQUEST_JOIN_CHANNEL,
  type TerminalRequestConnection,
} from '../terminal-socket-connection.js';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';
import { isSuperAdmin } from '../utils/branch-authorization.js';
import { resolveOwnerHomeStore, resolveSandboxStoragePaths } from '../utils/sandbox-context.js';
import {
  generateTerminalExecutorToken,
  getDaemonUrl,
  spawnExecutorFireAndForget,
} from '../utils/spawn-executor.js';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './tenant-authorization-fence.js';

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

interface TerminalStartReservation {
  tenantId: string;
  branchId: BranchID;
  promise: Promise<void>;
  cancelled: boolean;
}

interface TerminalExecutionProjection {
  branch: Branch;
  principalBranchAccess: 'write' | 'read';
  delegatedHomeKey?: string;
  executorEnv: Record<string, string>;
  sandboxHomeStore?: string;
  sandboxBaseRepoPath?: string;
  sandboxWorktreesRoot?: string;
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

export { terminalChannelName };

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
  private readonly starting = new Map<string, TerminalStartReservation>();

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
    events.on(LOCAL_AUTHORIZATION_INVALIDATION_EVENT, (data: { tenantId?: string }) => {
      if (data.tenantId) this.closeTenant(data.tenantId);
      else this.cleanup();
    });
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
    if (!data.branchId) throw new BadRequest('branchId is required to open a terminal');

    const config = this.app.get('config');
    const initialAuthorization = await runWithTenantDatabaseTransaction(
      this.db,
      tenantId,
      async (tenantDb) => {
        await lockTenantAuthorizationFence(tenantDb, params);
        const current = await resolveCurrentTenantAuthorityActor(tenantDb, params);
        if (current.service || !hasMinimumRole(current.role, ROLES.MEMBER)) {
          throw new Forbidden('Member access is required to open terminals');
        }
        const enforceBranchAccess = !isSuperAdmin(
          current.role,
          config.execution?.allow_superadmin === true
        );
        const branchRepo = new BranchRepository(tenantDb);
        const branch = await branchRepo.findAccessibleById(data.branchId!, userId, {
          minimumPermission: 'session',
          enforceAccess: enforceBranchAccess,
        });
        if (!branch) return null;
        if (!enforceBranchAccess) {
          return { branch, fsAccess: 'write' as const, enforceBranchAccess };
        }
        const access = await branchRepo.resolveUserAccess(branch, userId);
        return {
          branch,
          fsAccess: access.fs_access ?? ('none' as const),
          enforceBranchAccess,
        };
      }
    );
    const branch = initialAuthorization?.branch;
    // Missing and inaccessible branches deliberately share one response. The
    // terminal acknowledgement must not be a branch-existence oracle.
    if (!branch) throw new NotFound('Branch not found');
    if (branch.archived) throw new BadRequest(`Branch is archived: ${branch.name}`);
    const principalBranchAccess = initialAuthorization.fsAccess;
    if (principalBranchAccess === 'none') {
      throw new Forbidden('Filesystem access is required to open a terminal on this branch.');
    }

    const scopeKey = `${tenantId}:${userId}:${branch.branch_id}`;
    const pending = this.starting.get(scopeKey);
    if (pending) {
      await pending.promise;
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
    const reservationPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reservation: TerminalStartReservation = {
      tenantId,
      branchId: branch.branch_id,
      promise: reservationPromise,
      cancelled: false,
    };
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
        reservation,
        params,
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
    reservation: TerminalStartReservation;
    params: AuthenticatedParams;
  }): Promise<TerminalAttachment> {
    const {
      tenantId,
      userId,
      branch: initiallyAuthorizedBranch,
      data,
      config,
      scopeKey,
      joinRequestingSocket,
      reservation,
      params,
    } = args;
    const projection = await this.createExecutionProjection({
      tenantId,
      userId,
      branchId: initiallyAuthorizedBranch.branch_id,
      config,
      reservation,
      params,
    });
    const { branch, principalBranchAccess } = projection;
    if (reservation.cancelled) {
      throw new Forbidden('Terminal access changed while the terminal was starting.');
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

    this.terminals.set(terminalId, terminal);
    this.terminalByScope.set(scopeKey, terminalId);
    try {
      if (reservation.cancelled || this.terminals.get(terminalId) !== terminal) {
        throw new Forbidden('Terminal access changed while the terminal was starting.');
      }
      const joined = await joinRequestingSocket(channel, terminalRequestAllocation(terminal));
      if (!joined) throw new BadRequest('The owning Socket.IO connection disconnected.');
      if (reservation.cancelled || this.terminals.get(terminalId) !== terminal) {
        throw new Forbidden('Terminal access changed while the terminal was starting.');
      }

      const token = generateTerminalExecutorToken(
        this.app,
        {
          terminal_user_id: userId,
          terminal_id: terminalId,
          terminal_branch_id: branch.branch_id,
          terminal_owner_boot_id: identity.bootId,
        },
        TERMINAL_EXECUTOR_TOKEN_TTL
      );
      if (reservation.cancelled || this.terminals.get(terminalId) !== terminal) {
        throw new Forbidden('Terminal access changed while the terminal was starting.');
      }

      spawnExecutorFireAndForget(
        {
          command: 'zellij.attach',
          sessionToken: token,
          daemonUrl: getDaemonUrl(),
          params: {
            userId,
            terminalId,
            channel,
            sessionName,
            cwd: branch.path,
            cols: data.cols || 160,
            rows: data.rows || 40,
            sandboxHomeStore: projection.sandboxHomeStore,
            sandboxBaseRepoPath: projection.sandboxBaseRepoPath,
            sandboxWorktreesRoot: projection.sandboxWorktreesRoot,
            principalBranchAccess,
          },
        },
        {
          logPrefix: `[TerminalsService.executor ${shortId(userId)}/${shortId(terminalId)}]`,
          delegatedHomeKey: projection.delegatedHomeKey,
          env: projection.executorEnv,
          templateVariables: {
            unix_user: projection.delegatedHomeKey,
            executor_type: 'shell',
            user_id: userId,
            branch_id: branch.branch_id,
            branch_fs_access: principalBranchAccess,
            // Interactive shells are deliberately excluded from shared SDK
            // homes: native login commands could persist caller credentials
            // into branch-owned state. Delegated launchers receive the same
            // fail-closed empty value.
            branch_sdk_home: '',
          },
          onExit: () => this.handleExecutorExit(terminalId, userId),
        }
      );
      return terminal;
    } catch (error) {
      this.deleteTerminal(terminal);
      throw error;
    }
  }

  /**
   * Capture every identity, authorization, credential, home, and mount input
   * at one short fenced admission boundary. Process and Socket.IO side effects
   * happen only after this transaction commits.
   */
  private createExecutionProjection(args: {
    tenantId: string;
    userId: UserID;
    branchId: BranchID;
    config: AgorConfig;
    reservation: TerminalStartReservation;
    params: AuthenticatedParams;
  }): Promise<TerminalExecutionProjection> {
    const { tenantId, userId, branchId, config, reservation, params } = args;
    return runWithTenantDatabaseTransaction(this.db, tenantId, async (tenantDb) => {
      await lockTenantAuthorizationFence(tenantDb, params);
      const current = await resolveCurrentTenantAuthorityActor(tenantDb, params);
      if (current.service || !hasMinimumRole(current.role, ROLES.MEMBER)) {
        throw new Forbidden('Terminal access changed while the terminal was starting.');
      }
      const enforceCurrentAccess = !isSuperAdmin(
        current.role,
        config.execution?.allow_superadmin === true
      );
      const branchRepo = new BranchRepository(tenantDb);
      const branch = await branchRepo.findAccessibleById(branchId, userId, {
        minimumPermission: 'session',
        enforceAccess: enforceCurrentAccess,
      });
      if (!branch || branch.archived || reservation.cancelled) {
        throw new Forbidden('Terminal access changed while the terminal was starting.');
      }
      let principalBranchAccess: 'write' | 'read' | 'none' = 'write';
      if (enforceCurrentAccess) {
        const access = await branchRepo.resolveUserAccess(branch, userId);
        principalBranchAccess = access.fs_access ?? 'none';
      }
      if (principalBranchAccess === 'none') {
        throw new Forbidden('Terminal access changed while the terminal was starting.');
      }

      const user = await new UsersRepository(tenantDb).findById(userId);
      if (!user) {
        throw new Forbidden('Terminal access changed while the terminal was starting.');
      }
      const delegatedHome = resolveDelegatedHomeKey({
        mode: (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode,
        executionHomeKey: user.unix_username ?? null,
      });
      const executorEnv = await createUserProcessEnvironment(userId, tenantDb);

      const sandboxCfg = config.execution?.sandbox;
      const sandboxWorktreesRoot =
        sandboxCfg?.enabled === true
          ? resolveSandboxStoragePaths(config, tenantId).worktreesRoot
          : undefined;
      let sandboxBaseRepoPath: string | undefined;
      if (sandboxCfg?.enabled === true && branch.storage_mode !== 'clone' && branch.repo_id) {
        sandboxBaseRepoPath = await new RepoRepository(tenantDb)
          .findById(branch.repo_id)
          .then((repo) => repo?.local_path ?? undefined);
      }
      const sandboxHomeStore =
        sandboxCfg?.enabled === true && sandboxCfg.home_mode === 'per_user'
          ? resolveOwnerHomeStore({
              config,
              tenantId,
              ownerUserId: userId,
              filesystemHome: user.filesystem_home,
            })
          : undefined;

      return {
        branch,
        principalBranchAccess,
        delegatedHomeKey: delegatedHome.delegatedHomeKey || undefined,
        executorEnv,
        sandboxHomeStore,
        sandboxBaseRepoPath,
        sandboxWorktreesRoot,
      };
    });
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
    for (const reservation of this.starting.values()) reservation.cancelled = true;
    for (const terminal of [...this.terminals.values()]) this.stopTerminal(terminal);
  }

  closeBranch(tenantId: string, branchId: string): void {
    for (const reservation of this.starting.values()) {
      if (reservation.tenantId === tenantId && reservation.branchId === branchId) {
        reservation.cancelled = true;
      }
    }
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.tenantId === tenantId && terminal.branchId === branchId) {
        this.stopTerminal(terminal);
      }
    }
  }

  /** Revoke every process-local terminal capability for an invalidated tenant. */
  closeTenant(tenantId: string): void {
    for (const reservation of this.starting.values()) {
      if (reservation.tenantId === tenantId) reservation.cancelled = true;
    }
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.tenantId === tenantId) this.stopTerminal(terminal);
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
