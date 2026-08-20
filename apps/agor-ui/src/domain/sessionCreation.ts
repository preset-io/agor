import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  DefaultModelConfig,
  EffortLevel,
  PermissionMode,
} from '@agor-live/client';

export interface NewSessionConfig {
  branch_id: string;
  agent: string;
  agenticToolPresetId?: string;
  title?: string;
  initialPrompt?: string;
  modelConfig?: DefaultModelConfig;
  effort?: EffortLevel;
  mcpServerIds?: string[];
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
  envVarNames?: string[];
  /** Files are uploaded only after the session exists; never send them in the create payload. */
  attachmentFiles?: File[];
}

export type InitialContentPartStatus = 'not-requested' | 'pending' | 'delivered' | 'failed';

export type SessionSetupStageStatus = 'not-requested' | 'pending' | 'configured' | 'failed';

/** Exact content that remains to be delivered to an already-created session. */
export interface InitialContentRetry {
  prompt: string;
  attachmentFiles?: File[];
  permissionMode?: PermissionMode;
  /** Stable admission identity reused when a transport failure is ambiguous. */
  idempotencyKey: string;
}

export interface InitialContentDeliveryResult {
  prompt: InitialContentPartStatus;
  attachments: InitialContentPartStatus;
  retry?: InitialContentRetry;
}

interface SessionInitializationResultBase {
  sessionId: string;
  setup: SessionSetupResult;
  delivery: InitialContentDeliveryResult;
}

export type SessionInitializationResult =
  | (SessionInitializationResultBase & { status: 'complete' })
  | (SessionInitializationResultBase & {
      status: 'retryable';
      retry: SessionInitializationRetry;
    });

export interface SessionSetupResult {
  mcpServers: SessionSetupStageStatus;
  environmentVariables: SessionSetupStageStatus;
}

/** Exact remaining setup and content for an already-created session. */
export interface SessionInitializationRetry {
  mcpServerIds?: string[];
  envVarNames?: string[];
  content: InitialContentRetry;
}

export interface SessionInitializationDependencies extends InitialContentDeliveryDependencies {
  associateMcpServer: (sessionId: string, serverId: string) => Promise<void>;
  updateEnvironmentVariables: (sessionId: string, envVarNames: string[]) => Promise<void>;
  onSetupError?: (stage: 'mcpServers' | 'environmentVariables', error: unknown) => void;
}

export interface InitialContentDeliveryDependencies {
  /** Upload files and return the exact prompt containing their durable references. */
  uploadAttachments: (sessionId: string, prompt: string, files: File[]) => Promise<string>;
  sendPrompt: (
    sessionId: string,
    prompt: string,
    permissionMode: PermissionMode | undefined,
    idempotencyKey: string
  ) => Promise<boolean>;
  onAttachmentUploadError?: (error: unknown) => void;
}

/**
 * Deliver new-session content as one retryable unit. In particular, an upload
 * failure never falls through to a text-only send, which would make a safe
 * retry of the original draft impossible.
 */
export async function deliverInitialSessionContent(
  sessionId: string,
  content: InitialContentRetry,
  dependencies: InitialContentDeliveryDependencies
): Promise<InitialContentDeliveryResult> {
  const trimmedPrompt = content.prompt.trim();
  if (content.attachmentFiles?.length) {
    try {
      const finalPrompt = await dependencies.uploadAttachments(
        sessionId,
        content.prompt,
        content.attachmentFiles
      );
      const delivered = await dependencies.sendPrompt(
        sessionId,
        finalPrompt,
        content.permissionMode,
        content.idempotencyKey
      );
      return delivered
        ? {
            prompt: trimmedPrompt ? 'delivered' : 'not-requested',
            attachments: 'delivered',
          }
        : {
            prompt: trimmedPrompt ? 'failed' : 'not-requested',
            attachments: 'failed',
            // Upload succeeded; reuse its durable references on retry.
            retry: {
              prompt: finalPrompt,
              permissionMode: content.permissionMode,
              idempotencyKey: content.idempotencyKey,
            },
          };
    } catch (error) {
      dependencies.onAttachmentUploadError?.(error);
      return {
        prompt: trimmedPrompt ? 'pending' : 'not-requested',
        attachments: 'failed',
        retry: content,
      };
    }
  }

  if (!trimmedPrompt) {
    return { prompt: 'not-requested', attachments: 'not-requested' };
  }
  const delivered = await dependencies.sendPrompt(
    sessionId,
    content.prompt,
    content.permissionMode,
    content.idempotencyKey
  );
  return delivered
    ? { prompt: 'delivered', attachments: 'not-requested' }
    : { prompt: 'failed', attachments: 'not-requested', retry: content };
}

function pendingContentDelivery(content: InitialContentRetry): InitialContentDeliveryResult {
  return {
    prompt: content.prompt.trim() ? 'pending' : 'not-requested',
    attachments: content.attachmentFiles?.length ? 'pending' : 'not-requested',
  };
}

/**
 * Configure an already-created session before admitting its first prompt.
 * Successful setup steps are removed from the retry payload, so retries are
 * monotonic and never duplicate an MCP association that already succeeded.
 */
export async function initializeCreatedSession(
  sessionId: string,
  initialization: SessionInitializationRetry,
  dependencies: SessionInitializationDependencies
): Promise<SessionInitializationResult> {
  const setup: SessionSetupResult = {
    mcpServers: initialization.mcpServerIds?.length ? 'pending' : 'not-requested',
    environmentVariables: initialization.envVarNames?.length ? 'pending' : 'not-requested',
  };

  const failedMcpServerIds: string[] = [];
  for (const serverId of initialization.mcpServerIds ?? []) {
    try {
      await dependencies.associateMcpServer(sessionId, serverId);
    } catch (error) {
      failedMcpServerIds.push(serverId);
      dependencies.onSetupError?.('mcpServers', error);
    }
  }
  if (initialization.mcpServerIds?.length) {
    setup.mcpServers = failedMcpServerIds.length ? 'failed' : 'configured';
  }

  // Required configuration is ordered. Do not admit the prompt while any MCP
  // association is unresolved, and do not run later setup stages prematurely.
  if (failedMcpServerIds.length) {
    return {
      status: 'retryable',
      sessionId,
      setup,
      delivery: pendingContentDelivery(initialization.content),
      retry: {
        mcpServerIds: failedMcpServerIds,
        envVarNames: initialization.envVarNames,
        content: initialization.content,
      },
    };
  }

  if (initialization.envVarNames?.length) {
    try {
      await dependencies.updateEnvironmentVariables(sessionId, initialization.envVarNames);
      setup.environmentVariables = 'configured';
    } catch (error) {
      setup.environmentVariables = 'failed';
      dependencies.onSetupError?.('environmentVariables', error);
      return {
        status: 'retryable',
        sessionId,
        setup,
        delivery: pendingContentDelivery(initialization.content),
        retry: {
          envVarNames: initialization.envVarNames,
          content: initialization.content,
        },
      };
    }
  }

  const delivery = await deliverInitialSessionContent(
    sessionId,
    initialization.content,
    dependencies
  );
  return delivery.retry
    ? {
        status: 'retryable',
        sessionId,
        setup,
        delivery,
        retry: { content: delivery.retry },
      }
    : { status: 'complete', sessionId, setup, delivery };
}
