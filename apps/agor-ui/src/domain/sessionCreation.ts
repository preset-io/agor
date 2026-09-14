import type { SessionInitializationResult } from '@agor/core/api';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  DefaultModelConfig,
  EffortLevel,
  PermissionMode,
  Session,
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

export interface SessionCreationResult {
  /** Durable session id. It remains useful even when initialization failed. */
  sessionId: string;
  /** The durable session exists, but its first prompt was not confirmed admitted. */
  initializationFailed?: true;
  /** Preserve task identity/status; a resolved request does not prove executor launch. */
  initialization?: SessionInitializationResult;
}

export type SessionCreationStageResult =
  | { status: 'cancelled' }
  | { status: 'create-failed'; error: unknown }
  | {
      /** Request stages completed, not necessarily the executor launch or task. */
      status: 'complete';
      session: Session;
      prompt: string;
      initialization: SessionInitializationResult;
    }
  | { status: 'initialization-failed'; session: Session; prompt: string; error: unknown };

export interface SessionCreationStages {
  createSession: () => Promise<Session>;
  /** Runs only while the initiating caller still owns the operation. */
  onSessionCreated: (session: Session) => void;
  initialPrompt: string;
  preparePrompt?: (session: Session, prompt: string) => Promise<string>;
  initializeSession: (session: Session, prompt: string) => Promise<SessionInitializationResult>;
  /** Must synchronously validate both caller identity and auth generation. */
  shouldContinue: () => boolean;
}

/**
 * Browser-side seam around the one gap the daemon cannot own: attachments can
 * only be uploaded after the session exists. Every awaited stage revalidates
 * ownership before the next external or UI side effect.
 */
export async function runSessionCreationStages({
  createSession,
  onSessionCreated,
  initialPrompt,
  preparePrompt,
  initializeSession,
  shouldContinue,
}: SessionCreationStages): Promise<SessionCreationStageResult> {
  let session: Session;
  try {
    session = await createSession();
  } catch (error) {
    return shouldContinue() ? { status: 'create-failed', error } : { status: 'cancelled' };
  }

  if (!shouldContinue()) return { status: 'cancelled' };
  onSessionCreated(session);

  let prompt = initialPrompt;
  try {
    if (preparePrompt) {
      if (!shouldContinue()) return { status: 'cancelled' };
      prompt = await preparePrompt(session, prompt);
      if (!shouldContinue()) return { status: 'cancelled' };
    }

    if (!shouldContinue()) return { status: 'cancelled' };
    const initialization = await initializeSession(session, prompt);
    if (!shouldContinue()) return { status: 'cancelled' };
    return { status: 'complete', session, prompt, initialization };
  } catch (error) {
    return shouldContinue()
      ? { status: 'initialization-failed', session, prompt, error }
      : { status: 'cancelled' };
  }
}
