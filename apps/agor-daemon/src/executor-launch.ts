import { homedir } from 'node:os';
import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import { getBaseUrl } from '@agor/core/config';
import {
  BranchRepository,
  GatewayChannelRepository,
  getCurrentTenantId,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  shortId,
  UsersRepository,
} from '@agor/core/db';
import { getMcpServerAvailabilityForSession } from '@agor/core/mcp';
import { renderMcpAuthMissingContext } from '@agor/core/templates/mcp-auth-missing';
import type { SessionID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import type { SessionsServiceImpl, TasksServiceImpl } from './declarations.js';
import {
  containExecutorProcess,
  markExecutorProcessExited,
  retainExecutorContainmentFence,
  trackExecutorProcess,
} from './executor-tracking.js';
import {
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './integrations/opencode/native-state-coordinator.js';
import type { RegisterServicesContext } from './register-services.js';
import { prepareSessionForExecutorStart } from './services/executor-startup.js';
import type { ExecuteTaskData } from './services/sessions.js';
import { requestExecutorTermination } from './termination-coordinator.js';
import { appendSystemMessage } from './utils/append-system-message.js';
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

  return async (
    sessionId: string,
    data: ExecuteTaskData,
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type varies by context
    params: any
  ) => {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for executor startup');
    const session = await prepareSessionForExecutorStart(db, sessionsService, sessionId, params);
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
        // fail after startup. Keep expiry + in-memory revocation for these
        // scoped runtime credentials; revisit max-use semantics once they can
        // be counted per connection/task instead of per service method.
        maxUses: -1,
      }
    );

    const taskId = data.taskId;

    // Get branch path
    let cwd = process.cwd();
    if (session.branch_id) {
      const branchPath = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
        const branch = await new BranchRepository(tenantDb).findById(session.branch_id);
        return branch?.path;
      });
      if (!branchPath)
        throw new Error(`Branch ${session.branch_id} not found for executor startup`);
      cwd = branchPath;
    }

    // Determine Unix user for executor
    const {
      getHomedirFromUsername,
      resolveUnixUserForImpersonation,
      validateResolvedUnixUser,
      UnixUserNotFoundError,
    } = await import('@agor/core/unix');

    const unixUserMode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
    const configExecutorUser = config.execution?.executor_unix_user;
    const prompterUnixUser = prompterUser.unix_username;

    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode,
      userUnixUsername: prompterUnixUser,
      executorUnixUser: configExecutorUser,
    });

    const executorUnixUser = impersonationResult.unixUser;
    const executorHomeDir = executorUnixUser ? getHomedirFromUsername(executorUnixUser) : homedir();
    const effectivePermissionMode =
      data.permissionMode || session.permission_config?.mode || undefined;
    const permissionModeForPayload =
      effectivePermissionMode === 'default' ? undefined : effectivePermissionMode;

    // Validate Unix user
    try {
      validateResolvedUnixUser(unixUserMode, executorUnixUser);
    } catch (err) {
      if (err instanceof UnixUserNotFoundError) {
        throw new Error(
          `${(err as InstanceType<typeof UnixUserNotFoundError>).message}. Ensure the Unix user is created before attempting to execute sessions.`
        );
      }
      throw err;
    }

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
        !!executorUnixUser,
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
      asUser: executorUnixUser || undefined,
      preparedEnv: executorEnv,
      logPrefix,
      templateVariables: {
        session_id: sessionId,
        task_id: taskId,
        // Mode-resolved identity for the execution substrate: the sudo user in
        // insulated/strict, the session's unix_username in delegated (no sudo),
        // and unset in simple. Supersedes the interim
        // `prompterUnixUser || executorUnixUser` ordering from #2082, which
        // shadowed insulated mode's configured executor identity.
        unix_user: impersonationResult.reportedUnixUser || undefined,
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
              ...(executorUnixUser ? { asUser: executorUnixUser } : {}),
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

        appWithExecutor.sessionTokenService?.revokeToken(sessionToken);
        nativeState?.finished.resolve();
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
