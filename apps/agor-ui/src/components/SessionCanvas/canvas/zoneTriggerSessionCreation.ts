import type {
  AgenticToolName,
  AgorClient,
  DefaultModelConfig,
  PermissionMode,
  Session,
} from '@agor-live/client';

interface ZoneTriggerSessionCreationInput {
  branchId: string;
  zoneName: string;
  agent?: string;
  agenticToolPresetId?: string;
  modelConfig?: DefaultModelConfig;
  permissionMode?: PermissionMode;
  mcpServerIds?: string[];
}

/** Keep zone-trigger configuration in the session's atomic create request. */
export function createZoneTriggerSession(
  client: AgorClient,
  input: ZoneTriggerSessionCreationInput
): Promise<Session> {
  return client.service('sessions').create({
    branch_id: input.branchId,
    agentic_tool: (input.agent || 'claude-code') as AgenticToolName,
    agentic_tool_preset_id: input.agenticToolPresetId,
    description: `Session from zone "${input.zoneName}"`,
    status: 'idle',
    mcpServerIds: input.mcpServerIds?.length ? input.mcpServerIds : undefined,
    model_config: input.modelConfig
      ? {
          ...input.modelConfig,
          updated_at: new Date().toISOString(),
        }
      : undefined,
    permission_config: input.permissionMode
      ? {
          mode: input.permissionMode,
        }
      : undefined,
  });
}
