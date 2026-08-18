import { homedir } from 'node:os';
import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import {
  getBaseUrl,
  resolveDeploymentAgenticToolPolicy,
  resolveExecutionSecurityMode,
} from '@agor/core/config';
import {
  BranchRepository,
  GatewayChannelRepository,
  getCurrentTenantId,
  MCPServerRepository,
  RepoRepository,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  shortId,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import { getMcpServerAvailabilityForSession } from '@agor/core/mcp';
import { renderMcpAuthMissingContext } from '@agor/core/templates/mcp-auth-missing';
import type { SessionID, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import type { SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import {
  containExecutorProcess,
  markExecutorProcessExited,
  retainExecutorContainmentFence,
  trackExecutorProcess,
} from './executor-tracking.js';
import { assertHaTaskPermissionSupported } from './ha-support.js';
import {
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './integrations/opencode/native-state-coordinator.js';
import type { RegisterServicesContext } from './register-services.js';
import { prepareSessionForExecutorStart } from './services/executor-startup.js';
import type { ExecuteTaskData } from './services/sessions.js';
import { requestExecutorTermination } from './termination-coordinator.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { resolveOwnerHomeStore, resolveSandboxStoragePaths } from './utils/sandbox-context.js';
import { type SpawnExecutorOptions, spawnExecutor } from './utils/spawn-executor.js';
import { classifyExecutorExit } from './utils/task-launch-state.js';

function createDeferredSignal() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function createExecuteHandler(
  ctx: RegisterServicesContext,
  sessionsService: SessionsServiceImpl,
  sessionTokenService: import('./services/session-token-service.js').SessionTokenService
) {
  const { db, app, config, daemonUrl } = ctx;
  const deploymentAgenticToolPolicy = resolveDeploymentAgenticToolPolicy(config);
  // Only delegated execution reads the creator's home key back; local modes
  // do not consume the compatibility stamp.
  const unixIdentityGuard = resolveExecutionSecurityMode(config).requiresExecutionHomeKey
    ? {
        loadCreator: (tenantDb: TenantScopedDatabase) => (userId: string) =>
          new UsersRepository(tenantDb).findById(userId),
      }
    : undefined;

  return async (
    sessionId: string,
    data: ExecuteTaskData,
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type varies by context
    params: any
  ) => {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for executor startup');
    const session = await prepareSessionForExecutorStart(
      db,
      sessionsService,
      sessionId,
      params,
      deploymentAgenticToolPolicy,
      unixIdentityGuard
    );
    // Older direct-launch test harnesses omit deployment metadata; the live
    // register-services context always supplies it.
    if (ctx.deployment) {
      assertHaTaskPermissionSupported(ctx.deployment, {
        session,
        requestedMode: data.permissionMode,
      });
    }
    const prompterUserId = data.prompterUserId;
    const prompterUser = await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
      new UsersRepository(tenantDb).findById(prompterUserId)
    );
    if (!prompterUser) {
      throw new Error(`Task creator ${prompterUserId} not found for executor startup`);
    }
    if (
      session.agentic_tool_preset_id &&
      data.permissionMode !== undefined &&
      data.permissionMode !== session.permission_config?.mode
    ) {
      throw new Error('Preset-backed sessions cannot override permission mode per task');
    }
    if (session.agentic_tool === 'opencode') {
      if (!tenantId) throw new Error('Missing active tenant context for OpenCode execution');
      OPENCODE_DAEMON_CONTRIBUTION.admitExecutor({
        tenantId,
        config,
        modelConfig: session.model_config ?? undefined,
        sessionOwnerId: session.created_by,
        prompterUserId,
      });
    }

    // Generate session token for executor authentication
    const appWithExecutor = app as unknown as {
      sessionTokenService?: import('./services/session-token-service.js').SessionTokenService;
    };
    if (!appWithExecutor.sessionTokenService) {
      throw new Error('Session token service not initialized');
    }
    // Hook chain enforces auth before we get here.
    const sessionToken = await appWithExecutor.sessionTokenService.generateToken(
      sessionId,
      prompterUserId,
      {
        taskId: data.taskId,
        branchId: session.branch_id,
        // Executor JWTs authenticate on every daemon API call over the runtime
        // connection, so low per-call max-use limits make normal execution
        // fail after startup. Keep expiry + revocation for these scoped runtime
        // credentials; reconnect reuses the same token and does not consume a
        // separate connection allowance. Bounded tokens retain per-validation
        // use counting for compatibility.
        maxUses: -1,
      }
    );

    const taskId = data.taskId;

    // Get branch path (+ authoritative base repo path for the sandbox) and, for
    // RBAC-aware mounting, the session OWNER's effective filesystem access to
    // the branch. The filesystem sandbox binds `<baseRepoPath>/.git` writable so
    // worktree commits work; we resolve `repo.local_path` from Agor's own DB
    // state rather than parsing the on-disk `.git` pointer (deterministic, and
    // unaffected if a worktree's origin/gitdir is later rewritten).
    const sandboxCfg = config.execution?.sandbox;
    const rbacOn = config.execution?.branch_rbac === true;
    let cwd = process.cwd();
    let sandboxBaseRepoPath: string | undefined;
    const sandboxWorktreesRoot =
      sandboxCfg?.enabled === true
        ? resolveSandboxStoragePaths(config, tenantId).worktreesRoot
        : undefined;
    // Effective fs access of the OWNER on the branch: 'write' | 'read' | 'none'.
    // Drives whether the sandbox binds the branch rw / ro / not at all. Defaults
    // to 'write' when RBAC is off (open-access behavior).
    let principalBranchAccess: 'write' | 'read' | 'none' = 'write';
    if (session.branch_id) {
      const branchMounts = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
        const branchRepo = new BranchRepository(tenantDb);
        const branch = await branchRepo.findById(session.branch_id);
        if (!branch?.path) return undefined;
        let baseRepoPath: string | undefined;
        // Only linked worktrees need the shared git dir; a self-standing clone
        // carries its own `.git` inside the branch dir.
        if (branch.storage_mode !== 'clone' && branch.repo_id) {
          const repo = await new RepoRepository(tenantDb).findById(branch.repo_id);
          baseRepoPath = repo?.local_path ?? undefined;
        }
        let fsAccess: 'write' | 'read' | 'none' = 'write';
        if (rbacOn && session.created_by) {
          const access = await branchRepo.resolveUserAccess(branch, session.created_by as UUID);
          fsAccess =
            access.fs_access === 'write' ? 'write' : access.fs_access === 'read' ? 'read' : 'none';
        }
        return { path: branch.path, baseRepoPath, fsAccess };
      });
      if (!branchMounts)
        throw new Error(`Branch ${session.branch_id} not found for executor startup`);
      cwd = branchMounts.path;
      sandboxBaseRepoPath = branchMounts.baseRepoPath;
      principalBranchAccess = branchMounts.fsAccess;
      // Under the sandbox, 'none' means the branch would not be mounted at all,
      // so the task cannot operate on it. Fail fast with a clear message rather
      // than letting bwrap abort on a missing chdir target.
      if (sandboxCfg?.enabled === true && principalBranchAccess === 'none') {
        throw new Error(
          `The session owner has no filesystem access to branch ${session.branch_id}. ` +
            'Grant at least read access (others_fs_access) to run sessions on this branch under ' +
            'the filesystem sandbox.'
        );
      }
    }

    // Per-owner home store for `sandbox.home_mode: per_user` — a private,
    // persistent home overlaid at the passwd home inside the sandbox. Keyed by
    // the SESSION OWNER (not the prompter): the home carries the owner's tool
    // auth/state, so prompting another user's session runs against the owner's
    // home. The SOURCE is the owner's `filesystem_home`
    // if set (the migration points it at their existing /home/<user> so no files
    // move), else the canonical store (see resolveOwnerHomeStore). Only computed
    // when the mode is active — and FAIL CLOSED if the owner can't be resolved.
    let sandboxHomeStore: string | undefined;
    if (sandboxCfg?.enabled === true && sandboxCfg?.home_mode === 'per_user') {
      if (!session.created_by) {
        throw new Error(
          'sandbox home_mode=per_user requires a resolvable session owner; refusing to spawn ' +
            'with a shared home (fail closed).'
        );
      }
      const ownerFilesystemHome = await runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
        new UsersRepository(tenantDb)
          .findById(session.created_by as string)
          .then((u) => u?.filesystem_home?.trim() || undefined)
      );
      sandboxHomeStore = resolveOwnerHomeStore({
        config,
        tenantId,
        ownerUserId: session.created_by,
        filesystemHome: ownerFilesystemHome,
      });
    }

    // Resolve the optional delegated home key reported to an external launcher.
    // Local execution always runs as the daemon user.
    const { resolveDelegatedHomeKey } = await import('@agor/core/unix');

    const unixUserMode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
    const sessionUnixUser = session.unix_username;

    const delegatedHomeKeyResolution = resolveDelegatedHomeKey({
      mode: unixUserMode,
      executionHomeKey: sessionUnixUser,
    });

    const executorHomeDir = homedir();
    const effectivePermissionMode =
      data.permissionMode || session.permission_config?.mode || undefined;
    const permissionModeForPayload =
      effectivePermissionMode === 'default' ? undefined : effectivePermissionMode;

    // Resolve user environment variables
    const { createUserProcessEnvironment } = await import('@agor/core/config');
    // Resolve gateway-level env vars
    const gatewaySource = (session.custom_context as Record<string, unknown> | undefined)
      ?.gateway_source as { channel_id?: string } | undefined;
    const executorEnv = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
      let gatewayEnv: import('@agor/core/types').GatewayEnvVar[] | undefined;
      if (gatewaySource?.channel_id) {
        const { decryptApiKey, isEncrypted } = await import('@agor/core/db');
        const channel = await new GatewayChannelRepository(tenantDb).findById(
          gatewaySource.channel_id
        );
        if (channel?.agentic_config?.envVars) {
          gatewayEnv = channel.agentic_config.envVars.map((v) => ({
            ...v,
            value: (() => {
              if (!v.value || !isEncrypted(v.value)) return v.value;
              try {
                return decryptApiKey(v.value);
              } catch {
                return v.value;
              }
            })(),
          }));
        }
        // Merge connector-provided session credentials (e.g. Shortcut's API
        // token, which the media-intake skill uses to fetch ticket
        // attachments) as defaults. Operator `agentic_config.envVars` above
        // take precedence — a key already present is not overwritten.
        if (channel) {
          const { getConnector } = await import('@agor/core/gateway');
          const connectorEnv =
            getConnector(channel.channel_type, channel.config).sessionEnv?.() ?? [];
          if (connectorEnv.length > 0) {
            const present = new Set((gatewayEnv ?? []).map((e) => e.key));
            const defaults = connectorEnv.filter((e) => !present.has(e.key));
            if (defaults.length > 0) gatewayEnv = [...(gatewayEnv ?? []), ...defaults];
          }
        }
      }

      // Provider connections are resolved once by the executor through the
      // task-scoped daemon API. Generic process environment never carries them.
      return createUserProcessEnvironment(
        prompterUserId,
        tenantDb,
        undefined,
        gatewayEnv,
        sessionId as SessionID
      );
    });

    // Validate required user environment variables
    const requiredUserEnvVars = config.execution?.required_user_env_vars;
    if (requiredUserEnvVars && requiredUserEnvVars.length > 0) {
      const missingVars = requiredUserEnvVars.filter((v: string) => !executorEnv[v]);
      if (missingVars.length > 0) {
        const missingList = missingVars.map((v: string) => `\`${v}\``).join(', ');
        const errorContent = [
          `**Missing required environment variables:** ${missingList}`,
          '',
          'Your administrator requires these variables to be set before running prompts.',
          '',
          `**To fix:** Click your user avatar (top-right) → **Settings** → **Environment Variables**, then add values for: ${missingList}`,
          '',
          'This is a one-time setup — once configured, this message will not appear again.',
        ].join('\n');
        await runWithTenantDatabaseScope(db, tenantId, (_tenantDb) =>
          appendSystemMessage({
            app,
            db,
            sessionId,
            taskId: data.taskId,
            content: errorContent,
            contentPreview: `Missing required env vars: ${missingVars.join(', ')}`,
          })
        );
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
      }
    }

    executorEnv.DAEMON_URL = daemonUrl;

    const { unavailable: unavailableMcpServers } = await runWithTenantDatabaseScope(
      db,
      tenantId,
      (tenantDb) =>
        getMcpServerAvailabilityForSession(sessionId as SessionID, {
          sessionMCPRepo: new SessionMCPServerRepository(tenantDb),
          mcpServerRepo: new MCPServerRepository(tenantDb),
          sessionOwnerId: session.created_by,
          templateEnv: executorEnv,
          mcpOAuthAuthHeadersRepo: {
            async getAuthHeaders(mcpServerIds) {
              const result = (await app.service('mcp-servers/oauth-auth-headers').create(
                { mcp_server_ids: mcpServerIds },
                {
                  ...params,
                  provider: undefined,
                  user: prompterUser,
                }
              )) as {
                headers: Record<string, { authorization?: string; error?: string }>;
              };
              return result.headers;
            },
          },
        })
    );
    const authenticationRequired = unavailableMcpServers.filter(
      ({ reason }) => reason === 'authentication_required'
    );
    const runtimeContext =
      authenticationRequired.length > 0
        ? renderMcpAuthMissingContext({
            unavailable: authenticationRequired,
            baseUrl: await getBaseUrl(),
          })
        : '';
    const promptForProvider = runtimeContext ? `${runtimeContext}\n\n${data.prompt}` : data.prompt;

    const openCodeLaunch = (() => {
      if (session.agentic_tool !== 'opencode') return undefined;
      if (!tenantId) throw new Error('Missing active tenant context for OpenCode execution');
      if (!executorHomeDir) throw new Error('Missing executor home for OpenCode execution');
      return OPENCODE_DAEMON_CONTRIBUTION.getExecutorLaunch({
        tenantId,
        session,
        homeDir: executorHomeDir,
      });
    })();

    // Build executor payload
    const executorPayload = {
      command: 'prompt' as const,
      sessionToken,
      daemonUrl,
      ...(openCodeLaunch?.executorPayload ?? {}),
      env: executorEnv,
      params: {
        sessionId,
        taskId,
        prompt: promptForProvider,
        tool: session.agentic_tool as
          | 'claude-code'
          | 'gemini'
          | 'codex'
          | 'opencode'
          | 'copilot'
          | 'cursor',
        permissionMode: permissionModeForPayload as 'ask' | 'auto' | 'allow-all' | undefined,
        cwd,
        messageSource: data.messageSource,
        // Authoritative sandbox mount inputs (consumed in spawn-executor →
        // buildSandboxWrap). Undefined when the sandbox / per_user home is off.
        sandboxBaseRepoPath,
        sandboxHomeStore,
        sandboxWorktreesRoot,
        principalBranchAccess,
      },
    };

    const logPrefix = `[Executor ${shortId(sessionId)}]`;

    type NativeStateSpawn = {
      fence: OpenCodeNativeStateMutationFence;
      ready: ReturnType<typeof createDeferredSignal>;
      finished: ReturnType<typeof createDeferredSignal>;
      markSpawned(): void;
    };

    let localExecutorPid: number | undefined;
    const executorOptions = (nativeState?: NativeStateSpawn): SpawnExecutorOptions => ({
      delegatedHomeKey: delegatedHomeKeyResolution.delegatedHomeKey || undefined,
      preparedEnv: executorEnv,
      logPrefix,
      templateVariables: {
        session_id: sessionId,
        task_id: taskId,
        branch_id: session.branch_id,
        user_id: prompterUserId,
      },
      onSpawn: (child, spawnContext) => {
        nativeState?.markSpawned();
        if (spawnContext.mode === 'local' && child.pid) {
          localExecutorPid = child.pid;
          trackExecutorProcess(
            {
              sessionId,
              taskId,
              pid: child.pid,
            },
            app
          );
          console.log(`${logPrefix} PID: ${child.pid}`);
        }
        if (!nativeState) return;
        if (spawnContext.mode !== 'local' || !child.pid) {
          const error = new Error('OpenCode execution requires a locally tracked executor process');
          nativeState.ready.reject(error);
          return Promise.reject(error);
        }
        const handle = {
          retainContainmentFence: (key: string) =>
            retainExecutorContainmentFence(key, sessionId, taskId, app),
          verifyAbsence: async () =>
            (await containExecutorProcess(sessionId, taskId, {}, app)).status === 'verified_absent',
        };
        return nativeState.fence.attach(handle).then(
          () => nativeState.ready.resolve(),
          (error) => {
            nativeState.ready.reject(error);
            throw error;
          }
        );
      },
      onExit: async (code, spawnContext) => {
        console.log(`${logPrefix} Exited with code ${code}`);

        if (spawnContext.mode === 'local') {
          markExecutorProcessExited(sessionId, localExecutorPid, app);
        }

        let templatedLauncherAbsenceVerified = false;
        if (spawnContext.mode === 'templated') {
          const disposition = classifyExecutorExit({
            mode: spawnContext.mode,
            code,
            nonzeroMayHaveDispatched:
              config.execution?.executor_command_nonzero_may_have_dispatched === true,
          });
          if (disposition !== 'authoritative') {
            if (disposition === 'ambiguous') {
              try {
                await (
                  app.service('tasks') as unknown as TasksServiceImpl
                ).recordExecutorStartupWarning(
                  taskId,
                  `Executor launcher exited with code ${code ?? 'unknown'}, but configuration says remote work may have been dispatched.`,
                  { ...params, provider: undefined }
                );
              } catch (error) {
                console.warn(`${logPrefix} Failed to record ambiguous launcher exit:`, error);
              }
            }
            console.log(
              `${logPrefix} Launcher exit is passive; awaiting remote executor lifecycle`
            );
            nativeState?.finished.resolve();
            return;
          }
          templatedLauncherAbsenceVerified = true;
        }

        try {
          const termination = await requestExecutorTermination({
            app,
            taskId,
            cause: 'heartbeat_lost',
            errorMessage: `Executor exited unexpectedly with code ${code ?? 'unknown'}.`,
            params,
            // Missing a local process handle is never absence proof. A
            // configured authoritative templated-launcher failure is the one
            // launch path that can prove no remote executor was created.
            absenceVerified: templatedLauncherAbsenceVerified,
            sdkFailure: {
              reason: 'heartbeat_lost',
              detected_at: new Date().toISOString(),
              tool: session.agentic_tool,
              termination: 'requested',
            },
            // A remote executor may connect while its launcher is exiting.
            // Resolve that race only at the row-locked claim.
            ...(spawnContext.mode === 'templated'
              ? {
                  expectedStatus: TaskStatus.DISPATCHING,
                  requireExecutorDisconnected: true,
                }
              : {}),
          });
          if (termination.status === 'condition_changed') {
            console.log(`${logPrefix} Connected executor won the launcher-exit race`);
            nativeState?.finished.resolve();
            return;
          }
        } catch (error) {
          console.error(`❌ [Executor] Failed to coordinate executor exit:`, error);
        }

        try {
          // Launcher callbacks can outlive the tenant transaction that spawned
          // them. Leave any inherited DB scope before opening the fresh
          // tenant scope derived from the verified token claim.
          await runWithoutTenantDatabaseScope(() =>
            appWithExecutor.sessionTokenService?.revokeToken(sessionToken)
          );
        } finally {
          nativeState?.finished.resolve();
        }
      },
    });

    if (openCodeLaunch) {
      const ready = createDeferredSignal();
      const finished = createDeferredSignal();
      let spawned = false;
      const slot = inOpenCodeNativeStateMutationSlot(openCodeLaunch.namespaceKey, async (fence) => {
        try {
          spawnExecutor(
            executorPayload,
            executorOptions({ fence, ready, finished, markSpawned: () => (spawned = true) })
          );
          await ready.promise;
          await finished.promise;
        } catch (error) {
          if (!spawned) await fence.releaseWithoutWriter();
          throw error;
        }
      });
      void slot.catch((error) => {
        ready.reject(error);
        console.error(`${logPrefix} Native-state writer failed:`, error);
      });
      await ready.promise;
    } else {
      spawnExecutor(executorPayload, executorOptions());
    }

    return {
      success: true,
      taskId: taskId,
      status: 'running',
      streaming: data.stream !== false,
    };
  };
}

// ============================================================================
