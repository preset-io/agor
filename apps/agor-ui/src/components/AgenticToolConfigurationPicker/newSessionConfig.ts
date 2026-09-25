import type {
  AgenticToolName,
  Branch,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
  User,
} from '@agor-live/client';
import { getDefaultPermissionMode, mapToCodexPermissionConfig } from '@agor-live/client';
import type { NewSessionConfig } from '../../domain/sessionCreation';
import { resolveSessionMcpServerIds } from '../../utils/resolveQuickStartMcpServerIds';
import {
  type AgenticFormValues,
  buildConfigFromFormValues,
  getFormValuesFromConfig,
} from '../AgenticToolConfigForm/agenticConfigHelpers';
import {
  getUserAgenticToolDefault,
  getUserDefaultConfigurationSource,
  INLINE_AGENTIC_CONFIGURATION,
} from './useAgenticConfigurationSources';

/** Session-start form values; every field may be left unset. */
interface NewSessionFormValues extends AgenticFormValues {
  agenticToolPresetId?: string;
  mcpServerIds?: string[];
}

/** The branch fields session defaults depend on. */
type SessionConfigBranch = { branch_id: string } & Pick<Branch, 'mcp_server_ids'>;

/** The caller's saved agent configuration for a tool, as form values. */
function getNewSessionAgenticDefaults(
  user: User | null | undefined,
  tool: AgenticToolName
): NewSessionFormValues {
  return {
    agenticToolPresetId: getUserDefaultConfigurationSource(user, tool),
    ...getFormValuesFromConfig(tool, getUserAgenticToolDefault(user, tool).configuration),
  };
}

/** Form values to apply when the picked tool changes; clears Codex fields for other tools. */
export function getNewSessionToolSwitchValues(
  user: User | null | undefined,
  tool: AgenticToolName
): NewSessionFormValues {
  return {
    ...getNewSessionAgenticDefaults(user, tool),
    ...(tool !== 'codex' && {
      codexSandboxMode: undefined,
      codexApprovalPolicy: undefined,
      codexNetworkAccess: undefined,
    }),
  };
}

/** What an untouched session-start form holds for this caller, tool, and branch. */
export function getNewSessionDefaultValues(
  user: User | null | undefined,
  tool: AgenticToolName,
  branch?: Pick<Branch, 'mcp_server_ids'> | null
): NewSessionFormValues {
  return {
    ...getNewSessionAgenticDefaults(user, tool),
    mcpServerIds: resolveSessionMcpServerIds(user?.default_mcp_server_ids, branch),
  };
}

interface BuildNewSessionConfigOptions {
  user: User | null | undefined;
  tool: AgenticToolName;
  branch: SessionConfigBranch;
  /** Edited form values; omit to start from the caller's saved defaults. */
  values?: NewSessionFormValues;
  initialPrompt?: string;
  attachmentFiles?: File[];
}

/** Session config honoring the caller's saved defaults; shared by the new-session modal, quick compose, and the mobile shell. */
export function buildNewSessionConfig({
  user,
  tool,
  branch,
  values = getNewSessionDefaultValues(user, tool, branch),
  initialPrompt,
  attachmentFiles,
}: BuildNewSessionConfigOptions): NewSessionConfig {
  const agentDefaults = getUserAgenticToolDefault(user, tool).configuration;
  const permissionMode: PermissionMode =
    (values.permissionMode as PermissionMode | undefined) ??
    agentDefaults?.permissionMode ??
    getDefaultPermissionMode(tool);
  const isInline = values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION;
  const inlineConfig = isInline
    ? buildConfigFromFormValues(tool, {
        modelConfig: values.modelConfig,
        effort: values.effort,
        permissionMode: values.permissionMode,
      })
    : undefined;

  const config: NewSessionConfig = {
    branch_id: branch.branch_id,
    agent: tool,
    agenticToolPresetId: isInline ? undefined : values.agenticToolPresetId,
    initialPrompt,
    modelConfig: isInline
      ? inlineConfig?.modelConfig
      : (values.modelConfig ?? agentDefaults?.modelConfig),
    effort: isInline
      ? undefined
      : ((values.effort as EffortLevel | undefined) ?? agentDefaults?.modelConfig?.effort),
    mcpServerIds:
      values.mcpServerIds ?? resolveSessionMcpServerIds(user?.default_mcp_server_ids, branch),
    permissionMode,
    attachmentFiles: attachmentFiles && attachmentFiles.length > 0 ? attachmentFiles : undefined,
  };

  if (tool === 'codex') {
    const codexDefaults = mapToCodexPermissionConfig(permissionMode);
    config.codexSandboxMode =
      (values.codexSandboxMode as CodexSandboxMode | undefined) ??
      agentDefaults?.codexSandboxMode ??
      codexDefaults.sandboxMode;
    config.codexApprovalPolicy =
      (values.codexApprovalPolicy as CodexApprovalPolicy | undefined) ??
      agentDefaults?.codexApprovalPolicy ??
      codexDefaults.approvalPolicy;
    config.codexNetworkAccess =
      values.codexNetworkAccess ?? agentDefaults?.codexNetworkAccess ?? codexDefaults.networkAccess;
  }

  return config;
}
