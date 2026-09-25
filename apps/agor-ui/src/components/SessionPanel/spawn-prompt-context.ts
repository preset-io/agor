import type { SpawnConfig } from '@agor-live/client';

/** Keep the modal selection intact at the spawn-prompt transport boundary. */
export function buildSpawnPromptContext(config: string | Partial<SpawnConfig>) {
  return typeof config === 'string'
    ? { userPrompt: config }
    : {
        userPrompt: config.prompt || '',
        agenticTool: config.agent,
        presetId: config.presetId,
        permissionMode: config.permissionMode,
        modelConfig: config.modelConfig,
        codexSandboxMode: config.codexSandboxMode,
        codexApprovalPolicy: config.codexApprovalPolicy,
        codexNetworkAccess: config.codexNetworkAccess,
        mcpServerIds: config.mcpServerIds,
        callbackConfig: {
          enableCallback: config.enableCallback,
          includeLastMessage: config.includeLastMessage,
          includeOriginalPrompt: config.includeOriginalPrompt,
        },
        extraInstructions: config.extraInstructions,
      };
}
