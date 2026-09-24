/**
 * Thin OpenCode SDK adapter.
 *
 * Agor orchestration stays here; the OpenCode package owns the complete managed turn.
 * Task settlement remains OpenCode-scoped until the generic runner migration lands.
 */

import {
  buildOpenCodeAuthContent,
  hostedCredentialFieldForProvider,
  isOpenCodeManagedExecutorContext,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  parseOpenCodeExecutorContext,
} from '@agor/agentic-tool-opencode';
import {
  assertOpenCodeCheckpointRuntime,
  discardOpenCodeScratch,
  isOpenCodeCleanupUnverifiedError,
  OpenCodeTool,
  prepareOpenCodeScratch,
  resolveOpenCodeNativeStateLayout,
  restoreOpenCodeAcceptedState,
} from '@agor/agentic-tool-opencode/runtime';
import { generateId, shortId } from '@agor/core';
import { getMcpServersForSession } from '@agor/core/mcp';
import type {
  ExecutorPulseKind,
  MessageID,
  MessageSource,
  PermissionMode,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { getDaemonUrl } from '../../config.js';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type {
  ManagedOpenCodeAdmission,
  ManagedOpenCodeNativeStateManifest,
} from '../../managed-opencode-admission.js';
import { isRetryableTransportFailure } from '../../managed-opencode-admission.js';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { PermissionService } from '../../permissions/permission-service.js';
import { resolveContextUserId } from '../../sdk-handlers/base/context-user.js';
import { enrichContentBlocks } from '../../sdk-handlers/base/diff-enrichment.js';
import { EMPTY_MCP_TOOL_PERMISSION_INDEX } from '../../sdk-handlers/base/mcp-tool-permissions.js';
import { createCanUseToolCallback } from '../../sdk-handlers/base/permission-hooks.js';
import {
  collectWithheldMcpServers,
  reportWithheldMcpServers,
} from '../../sdk-handlers/base/withheld-mcp-report.js';
import { createUserMessage } from '../../sdk-handlers/claude/message-builder.js';
import type { AgorClient } from '../../services/feathers-client.js';
import {
  createStreamingCallbacks,
  MissingCredentialError,
  resolveApiKeyForTask,
  settleTaskFailure,
} from './base-executor.js';
import { OpenCodeCleanupOperation } from './opencode-cleanup.js';

interface ManagedOpenCodeStateService {
  closeRead(input: {
    task_id: string;
    holder_instance_id: string;
    input: { storeId: string; taskId: string };
  }): Promise<void>;
  seal(input: {
    task_id: string;
    holder_instance_id: string;
    manifest: import('../../managed-opencode-admission.js').ManagedOpenCodeNativeStateManifest;
  }): Promise<void>;
  abandon(input: { task_id: string; holder_instance_id: string }): Promise<void>;
}

interface ManagedOpenCodeNativeStateLayout {
  homeDir: string;
  namespaceKey: string;
  agorSessionId: string;
  storeId: string;
  attemptsDir: string;
  attemptTaskId: string;
  scratchRoot: string;
  liveDbPath: string;
  xdg: { data: string; config: string; cache: string; state: string };
}

type ManagedNativeManifest = ManagedOpenCodeNativeStateManifest;

function managedStateService(client: AgorClient): ManagedOpenCodeStateService {
  return client.service(
    'opencode-native-state' as string
  ) as unknown as ManagedOpenCodeStateService;
}

const MANAGED_WRITE_RETRY_DELAYS_MS = [200, 500, 1_000] as const;

function samePublishedAttempt(left: unknown, right: ManagedNativeManifest): boolean {
  if (!left || typeof left !== 'object') return false;
  const candidate = left as Partial<ManagedNativeManifest>;
  return (
    candidate.version === right.version &&
    candidate.storeId === right.storeId &&
    candidate.attemptTaskId === right.attemptTaskId &&
    candidate.digest === right.digest &&
    candidate.bytes === right.bytes &&
    candidate.openCodeSessionId === right.openCodeSessionId &&
    candidate.openCodeVersion === right.openCodeVersion &&
    candidate.publishedAt === right.publishedAt
  );
}

async function waitForManagedWriteRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, MANAGED_WRITE_RETRY_DELAYS_MS[attempt]));
}

export async function executeOpenCodeTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  agenticToolContext?: Record<string, unknown>;
  managedOpenCodeAdmission?: ManagedOpenCodeAdmission;
  resolvedConfig?: ResolvedConfigSlice;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}): Promise<void> {
  const { client, sessionId, taskId, prompt } = params;
  console.log(`[opencode] Executing task ${shortId(taskId)}...`);

  const permissionService = new PermissionService(async (event, data) => {
    if (event === 'permission:request') params.onPulse?.('waiting', 'permission.request');
    if (event === 'permission:timeout') params.onPulse?.('sdk_started', 'permission.timeout');
    client.service('sessions').emit(event, data);
  }, params.resolvedConfig?.execution?.permission_timeout_ms ?? 600_000);
  globalPermissionManager.register(sessionId, permissionService);
  let managedScratch: ManagedOpenCodeNativeStateLayout | undefined;
  let managedLayoutForErrors: ManagedOpenCodeNativeStateLayout | undefined;
  const committedGrant = params.managedOpenCodeAdmission;
  const managedPayloadCandidate =
    !!params.agenticToolContext &&
    (params.agenticToolContext.mode === 'managed-projection' ||
      params.agenticToolContext.version !== undefined);
  let inputReadClosed = !committedGrant?.input;
  let managedIoSettled = false;
  let sealAmbiguous = false;
  let completionAmbiguous = false;
  let cleanupOperation: OpenCodeCleanupOperation | undefined;
  const stopCleanupOnAbort = () => cleanupOperation?.stopScheduling();

  const closeInputAndAbandon = async (): Promise<void> => {
    if (!committedGrant) return;
    const service = managedStateService(client);
    if (committedGrant.input && !inputReadClosed) {
      await service.closeRead({
        task_id: taskId,
        holder_instance_id: committedGrant.attempt.holder_instance_id,
        input: {
          storeId: committedGrant.input.storeId,
          taskId: committedGrant.input.attemptTaskId,
        },
      });
      inputReadClosed = true;
    }
    await service.abandon({
      task_id: taskId,
      holder_instance_id: committedGrant.attempt.holder_instance_id,
    });
    managedIoSettled = true;
  };

  try {
    const session = await client.service('sessions').get(sessionId);
    if (!session.model_config?.provider?.trim() || !session.model_config.model?.trim()) {
      throw new Error(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
    }
    const context = parseOpenCodeExecutorContext(params.agenticToolContext);
    const managedContext = isOpenCodeManagedExecutorContext(context) ? context : undefined;
    const dataHome = isOpenCodeManagedExecutorContext(context) ? undefined : context.dataHome;
    if (managedContext && managedContext.taskId !== taskId) {
      throw new Error('OpenCode managed executor context does not belong to this task');
    }

    const repos = createFeathersBackedRepositories(client);
    const contextUserId = await resolveContextUserId({
      session,
      taskId,
      tasksService: repos.tasksService,
    });
    const branch = session.branch_id ? await repos.branches.findById(session.branch_id) : null;
    if (!branch?.path) throw new Error('OpenCode requires an Agor branch working directory');

    // Managed v3 authority is committed by the outer executor before this
    // runner. The payload contains logical identity only; it never chooses an
    // accepted pointer or holder.
    let managed: NonNullable<Parameters<OpenCodeTool['runTurn']>[0]['managed']> | undefined;
    if (managedContext) {
      if (
        !committedGrant ||
        committedGrant.attempt.task_id !== taskId ||
        committedGrant.attempt.holder_instance_id.length === 0 ||
        committedGrant.attempt.write_state !== 'open' ||
        committedGrant.attempt.retired_at ||
        (committedGrant.attempt.store_id !== committedGrant.input?.storeId &&
          committedGrant.input !== null) ||
        managedContext.agorSessionId !== sessionId ||
        managedContext.taskId !== taskId
      ) {
        throw new Error('OpenCode managed executor lacks an exact active DB holder grant');
      }
      // Fail early on an executor image that cannot run the durability barrier
      // instead of spending a full provider turn first.
      await assertOpenCodeCheckpointRuntime();
      // Resolve the layout (which requires the pinned scratch root) before the
      // owner's keys enter executor memory, so an unpinned image fails before
      // any credential read.
      const nativeState = (
        resolveOpenCodeNativeStateLayout as unknown as (input: {
          namespaceKey: string;
          agorSessionId: string;
          taskId: string;
          storeId: string;
        }) => ManagedOpenCodeNativeStateLayout
      )({
        namespaceKey: managedContext.namespaceKey,
        agorSessionId: managedContext.agorSessionId,
        taskId,
        storeId: committedGrant.attempt.store_id,
      });
      managedLayoutForErrors = nativeState;
      const provider = session.model_config.provider.trim();
      const credentialField = hostedCredentialFieldForProvider(provider);
      if (!credentialField) {
        throw new MissingCredentialError(
          'This OpenCode provider is not supported in hosted mode. Choose a supported provider in Settings > OpenCode.'
        );
      }
      const resolution = await resolveApiKeyForTask(credentialField, client, taskId, 'opencode');
      if (resolution.decryptionFailed) {
        throw new Error(
          'A saved OpenCode provider key could not be decrypted. Re-enter it in Settings > OpenCode.'
        );
      }
      const projected = buildOpenCodeAuthContent(resolution.connection ?? {}, provider);
      if (!projected.content) {
        throw new MissingCredentialError(
          'The OpenCode provider selected for this session has no saved key. Save its key in Settings > OpenCode.'
        );
      }
      await (
        prepareOpenCodeScratch as unknown as (
          layout: ManagedOpenCodeNativeStateLayout
        ) => Promise<void>
      )(nativeState);
      managedScratch = nativeState;
      if (committedGrant.input) {
        if (committedGrant.input.storeId !== nativeState.storeId) {
          throw new Error('OpenCode DB input pin does not match the immutable store');
        }
        try {
          await (
            restoreOpenCodeAcceptedState as unknown as (
              layout: ManagedOpenCodeNativeStateLayout,
              accepted: ManagedOpenCodeNativeStateManifest
            ) => Promise<void>
          )(nativeState, committedGrant.input);
        } finally {
          // restore settles only after every source descriptor has closed, on
          // both successful verification and copy failure.
          await managedStateService(client).closeRead({
            task_id: taskId,
            holder_instance_id: committedGrant.attempt.holder_instance_id,
            input: {
              storeId: committedGrant.input.storeId,
              taskId: committedGrant.input.attemptTaskId,
            },
          });
          inputReadClosed = true;
        }
      }
      if (params.abortController.signal.aborted) {
        await closeInputAndAbandon();
        return;
      }
      cleanupOperation = new OpenCodeCleanupOperation(
        client,
        taskId,
        committedGrant.attempt.holder_instance_id,
        nativeState
      );
      cleanupOperation.start();
      params.abortController.signal.addEventListener('abort', stopCleanupOnAbort, { once: true });
      if (params.abortController.signal.aborted) stopCleanupOnAbort();
      managed = {
        authContent: projected.content,
        authSecrets: projected.secrets,
        nativeState,
        input: committedGrant.input,
      } as unknown as NonNullable<Parameters<OpenCodeTool['runTurn']>[0]['managed']>;
    } else if (committedGrant) {
      throw new Error('OpenCode holder grant has no matching managed execution context');
    }

    const [messages, sessionNextIndex] = await Promise.all([
      repos.messages.findInitialUserMessagesByTaskId(taskId),
      repos.messages.getNextIndexBySessionId(sessionId),
    ]);
    await createUserMessage(sessionId, prompt, taskId, sessionNextIndex, repos.messagesService, {
      messageSource: params.messageSource,
      existingMessages: messages,
    });
    if (params.abortController.signal.aborted) {
      await closeInputAndAbandon();
      await cleanupOperation?.stopAndDrain();
      return;
    }

    const assistantMessageId = generateId() as MessageID;
    const permissionLocks = new Map<SessionID, Promise<void>>();
    const permissionTasksService = committedGrant
      ? {
          get: (id: string) => repos.tasksService.get(id),
          patch: (id: string, data: Partial<import('@agor/core/types').Task>) => {
            if (id !== taskId) throw new Error('Permission patch is not scoped to this task');
            return repos.tasksService.patch(id, {
              ...data,
              native_state_holder_instance_id: committedGrant.attempt.holder_instance_id,
            } as Partial<import('@agor/core/types').Task>);
          },
          emit: (event: string, data: unknown) => repos.tasksService.emit(event, data),
        }
      : repos.tasksService;
    const tool = new OpenCodeTool({
      resolveMcpServers: async (targetSessionId) => {
        const reporter = collectWithheldMcpServers();
        const servers = await getMcpServersForSession(
          targetSessionId,
          {
            sessionMCPRepo: repos.sessionMCP,
            mcpServerRepo: repos.mcpServers,
            mcpOAuthAuthHeadersRepo: repos.mcpOAuthAuthHeaders,
            forUserId: contextUserId,
            onServerWithheld: reporter.onServerWithheld,
          },
          // OpenCode's invocation config still carries no per-tool filter, but
          // every MCP tool call comes back through Agor before it runs: the
          // managed server asks permission using the tool's own key as the
          // permission type, and Agor mints that key when it registers the
          // server, so the match is exact. Enforcement happens there
          // (`applyPermissionEffect`) instead of by withholding the server.
          { toolFiltering: 'intercept' }
        );
        await reportWithheldMcpServers(repos.messages, {
          sessionId: targetSessionId,
          taskId,
          withheld: reporter.withheld,
        });
        return servers;
      },
      getDaemonUrl,
      createPermissionCallback: (targetSessionId, targetTaskId) =>
        createCanUseToolCallback(targetSessionId, targetTaskId, {
          permissionService,
          tasksService: permissionTasksService,
          messagesRepo: repos.messages,
          messagesService: repos.messagesService,
          sessionsService: repos.sessionsService,
          permissionLocks,
          mcpServerRepo: repos.mcpServers,
          sessionMCPRepo: repos.sessionMCP,
          // Deliberately empty. This callback only ever sees OpenCode's own
          // permission keys (`<server key>_<tool>`), which the namespaced
          // `mcp__server__tool` resolver cannot match -- and a miss would read
          // as "unconfigured", i.e. allow. The per-tool gate for this handler
          // lives in `applyPermissionEffect`, keyed the way OpenCode names
          // things, and runs before this callback is reached.
          mcpToolPermissions: EMPTY_MCP_TOOL_PERMISSION_INDEX,
        }),
      cancelPendingPermissions: (targetSessionId) =>
        permissionService.cancelPendingRequests(targetSessionId),
      enrichContentBlocks: (blocks) =>
        enrichContentBlocks(blocks, {
          workingDirectory: branch.path,
          snapshotScope: `${sessionId}:${taskId}`,
        }),
    });
    const result = await tool.runTurn(
      {
        agorSessionId: sessionId,
        taskId,
        prompt,
        agorAssistantMessageId: assistantMessageId,
        // Managed turns resume only the accepted checkpoint's native session;
        // an unpublished sdk_session_id from a failed turn is never reused.
        existingOpenCodeSessionId: managed
          ? (committedGrant?.input?.openCodeSessionId ?? undefined)
          : session.sdk_session_id,
        title: session.title || `Task ${shortId(taskId)}`,
        directory: branch.path,
        provider: session.model_config.provider,
        model: session.model_config.model,
        effort: session.model_config.effort,
        mcpToken: session.mcp_token,
        permissionMode: params.permissionMode,
        signal: params.abortController.signal,
        dataHome,
        managed,
        persistOpenCodeSessionId: async (openCodeSessionId) => {
          if (!managed)
            await client
              .service('sessions')
              .patch(sessionId, { sdk_session_id: openCodeSessionId });
        },
      },
      createStreamingCallbacks(client, 'opencode', sessionId, taskId, params.onPulse)
    );

    if (params.abortController.signal.aborted) {
      await closeInputAndAbandon();
      await cleanupOperation?.stopAndDrain();
      return;
    }
    const publishedManifest = result.nativeStateAttempt as unknown as
      | ManagedNativeManifest
      | undefined;
    if (managed && !publishedManifest) {
      throw new Error('OpenCode managed turn completed without a published checkpoint');
    }
    if (managed && committedGrant && publishedManifest) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await managedStateService(client).seal({
            task_id: taskId,
            holder_instance_id: committedGrant.attempt.holder_instance_id,
            manifest: publishedManifest,
          });
          break;
        } catch (error) {
          if (!isRetryableTransportFailure(error)) throw error;
          sealAmbiguous = true;
          if (attempt >= MANAGED_WRITE_RETRY_DELAYS_MS.length) throw error;
          await waitForManagedWriteRetry(attempt);
        }
      }
      managedIoSettled = true;
      sealAmbiguous = false;
      // A short healthy turn still gives cleanup its bounded per-launch budget.
      // Do not leave a committed delete worker behind task completion.
      await cleanupOperation?.finishWithin(2_000);
      if (params.abortController.signal.aborted) return;
    }

    const finalIndex = await repos.messages.getNextIndexBySessionId(sessionId);
    await repos.messagesService.create({
      message_id: assistantMessageId,
      session_id: sessionId,
      task_id: taskId,
      type: 'assistant' as const,
      role: MessageRole.ASSISTANT,
      index: finalIndex,
      timestamp: new Date().toISOString(),
      content_preview: result.finalMessage.content.substring(0, 200),
      content: result.finalMessage.contentBlocks,
      tool_uses: result.finalMessage.toolUses.length > 0 ? result.finalMessage.toolUses : undefined,
      metadata: result.finalMessage.metadata,
    });
    const completionPatch = {
      status: 'completed',
      completed_at: new Date().toISOString(),
      model: `${session.model_config.provider}/${session.model_config.model}`,
      // The daemon accepts this pointer only together with completion, Session
      // lock first; a terminal task refuses it (stale writer fence).
      ...(publishedManifest ? { native_state_attempt: publishedManifest } : {}),
      ...(committedGrant
        ? { native_state_holder_instance_id: committedGrant.attempt.holder_instance_id }
        : {}),
    } as Partial<import('@agor/core/types').Task>;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const committed = await client.service('tasks').patch(taskId, completionPatch);
        if (
          managed &&
          publishedManifest &&
          committed.status === 'completed' &&
          !samePublishedAttempt(committed.native_state_attempt, publishedManifest)
        ) {
          throw new Error('Managed OpenCode completion pointer does not match the sealed output');
        }
        break;
      } catch (error) {
        if (!managed || !publishedManifest || !isRetryableTransportFailure(error)) throw error;
        completionAmbiguous = true;
        const current = await client
          .service('tasks')
          .get(taskId)
          .catch(() => null);
        if (
          current?.status === 'completed' &&
          samePublishedAttempt(current.native_state_attempt, publishedManifest)
        )
          break;
        if (attempt >= MANAGED_WRITE_RETRY_DELAYS_MS.length) throw error;
        await waitForManagedWriteRetry(attempt);
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (committedGrant && managedLayoutForErrors) {
      // Preparation and restore can fail before OpenCode's own sanitizer is
      // installed. Never persist private HOME/scratch paths in Task errors.
      const sensitive = [
        managedLayoutForErrors.homeDir,
        managedLayoutForErrors.attemptsDir,
        managedLayoutForErrors.scratchRoot,
        managedLayoutForErrors.liveDbPath,
        ...Object.values(managedLayoutForErrors.xdg),
        managedLayoutForErrors.namespaceKey,
      ]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      for (const value of sensitive) {
        failure.message = failure.message.replaceAll(value, '[managed state]');
      }
    }
    console.error('[opencode] execution failed category=task_execution');

    if (managedPayloadCandidate && !committedGrant) {
      // The outer executor owns shared-Task lifecycle before invoking any
      // handler. Missing or rejected grants have no transcript, credential,
      // provider, or terminal side effects here.
      return;
    }

    if (isOpenCodeCleanupUnverifiedError(failure)) {
      // Keep the task active. Executor exit hands containment to the daemon;
      // making it terminal here would release the session before absence is proven.
      if (params.abortController.signal.aborted) await cleanupOperation?.stopAndDrain();
      return;
    }
    if (sealAmbiguous || completionAmbiguous) {
      // An accepted write can have lost only its response. Never abandon or
      // terminalize a possibly sealed object from an ambiguous transport fact.
      console.warn('[opencode] event=managed_publication_unverified');
      if (params.abortController.signal.aborted) await cleanupOperation?.stopAndDrain();
      return;
    }
    if (committedGrant && !managedIoSettled) {
      try {
        // If a source restore failed, it has settled and closed every source
        // descriptor before reaching this catch. If it never settled, this
        // code is never reached and the DB pin remains live for Cloud proof.
        await closeInputAndAbandon();
      } catch {
        console.warn('[opencode] managed checkpoint I/O drain unverified; task remains guarded');
        if (params.abortController.signal.aborted) await cleanupOperation?.stopAndDrain();
        return;
      }
    }
    if (params.abortController.signal.aborted) {
      await cleanupOperation?.stopAndDrain();
      return;
    }
    if (!params.abortController.signal.aborted) {
      await settleTaskFailure(
        client,
        sessionId,
        taskId,
        failure,
        {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: failure.message,
        },
        committedGrant?.attempt.holder_instance_id
      );
    }
    throw failure;
  } finally {
    params.abortController.signal.removeEventListener('abort', stopCleanupOnAbort);
    await cleanupOperation?.stopAndDrain();
    globalPermissionManager.unregister(sessionId);
    if (managedScratch) {
      await (
        discardOpenCodeScratch as unknown as (
          layout: ManagedOpenCodeNativeStateLayout
        ) => Promise<void>
      )(managedScratch);
    }
  }
}
