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

export interface SessionCreationResult {
  /** Durable session id. It remains useful even when initialization failed. */
  sessionId: string;
}
