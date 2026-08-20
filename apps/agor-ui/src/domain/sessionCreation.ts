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

/** Exact content that remains to be delivered to an already-created session. */
export interface InitialContentRetry {
  prompt: string;
  attachmentFiles?: File[];
  permissionMode?: PermissionMode;
}

export interface InitialContentDeliveryResult {
  prompt: InitialContentPartStatus;
  attachments: InitialContentPartStatus;
  retry?: InitialContentRetry;
}

export interface NewSessionCreationResult {
  sessionId: string;
  delivery: InitialContentDeliveryResult;
}

export interface InitialContentDeliveryDependencies {
  /** Upload files and return the exact prompt containing their durable references. */
  uploadAttachments: (sessionId: string, prompt: string, files: File[]) => Promise<string>;
  sendPrompt: (
    sessionId: string,
    prompt: string,
    permissionMode?: PermissionMode
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
        content.permissionMode
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
            retry: { prompt: finalPrompt, permissionMode: content.permissionMode },
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
    content.permissionMode
  );
  return delivered
    ? { prompt: 'delivered', attachments: 'not-requested' }
    : { prompt: 'failed', attachments: 'not-requested', retry: content };
}

export function isInitialContentDelivered(result: InitialContentDeliveryResult): boolean {
  return !result.retry;
}
