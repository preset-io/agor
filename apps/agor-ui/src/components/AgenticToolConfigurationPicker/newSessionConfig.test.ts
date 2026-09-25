import type { Branch, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildNewSessionConfig,
  getNewSessionDefaultValues,
  getNewSessionToolSwitchValues,
} from './newSessionConfig';
import {
  INLINE_AGENTIC_CONFIGURATION,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
} from './useAgenticConfigurationSources';

const branch = { branch_id: 'branch-1', mcp_server_ids: ['branch-mcp'] } as unknown as Branch;

const user = {
  user_id: 'user-1',
  default_mcp_server_ids: ['user-mcp'],
  default_agentic_config: {
    'claude-code': {
      modelConfig: { model: 'claude-opus', effort: 'high' },
      permissionMode: 'acceptEdits',
    },
    codex: {
      permissionMode: 'allow-all',
      codexSandboxMode: 'read-only',
      codexApprovalPolicy: 'on-failure',
    },
  },
} as unknown as User;

describe('getNewSessionDefaultValues', () => {
  it('seeds the saved agent config and branch-inherited MCP servers', () => {
    expect(getNewSessionDefaultValues(user, 'claude-code', branch)).toEqual({
      agenticToolPresetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      modelConfig: { model: 'claude-opus', effort: 'high' },
      effort: 'high',
      permissionMode: 'acceptEdits',
      mcpServerIds: ['branch-mcp'],
    });
  });

  it('falls back to the caller MCP defaults before a branch is known', () => {
    expect(getNewSessionDefaultValues(user, 'claude-code').mcpServerIds).toEqual(['user-mcp']);
  });
});

describe('getNewSessionToolSwitchValues', () => {
  it('clears Codex fields when switching to another tool, leaving MCP servers alone', () => {
    const values = getNewSessionToolSwitchValues(user, 'claude-code');
    expect(values).toMatchObject({
      agenticToolPresetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      permissionMode: 'acceptEdits',
    });
    for (const field of ['codexSandboxMode', 'codexApprovalPolicy', 'codexNetworkAccess']) {
      expect(field in values).toBe(true);
      expect(values[field as keyof typeof values]).toBeUndefined();
    }
    expect('mcpServerIds' in values).toBe(false);
  });

  it('keeps the saved Codex fields when switching to Codex', () => {
    expect(getNewSessionToolSwitchValues(user, 'codex')).toMatchObject({
      permissionMode: 'allow-all',
      codexSandboxMode: 'read-only',
      codexApprovalPolicy: 'on-failure',
    });
  });
});

describe('buildNewSessionConfig', () => {
  it('honors the caller saved defaults when no form values are supplied', () => {
    expect(buildNewSessionConfig({ user, tool: 'claude-code', branch, initialPrompt: '' })).toEqual(
      {
        branch_id: 'branch-1',
        agent: 'claude-code',
        agenticToolPresetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        initialPrompt: '',
        modelConfig: { model: 'claude-opus', effort: 'high' },
        effort: 'high',
        mcpServerIds: ['branch-mcp'],
        permissionMode: 'acceptEdits',
        attachmentFiles: undefined,
      }
    );
  });

  it('lets edited form values win, and treats an emptied MCP list as explicit', () => {
    const config = buildNewSessionConfig({
      user,
      tool: 'claude-code',
      branch,
      values: { permissionMode: 'plan', mcpServerIds: [] },
      initialPrompt: 'hi',
    });
    expect(config.permissionMode).toBe('plan');
    expect(config.mcpServerIds).toEqual([]);
    expect(config.initialPrompt).toBe('hi');
  });

  it('sends an inline selection as explicit config with no preset reference', () => {
    const config = buildNewSessionConfig({
      user,
      tool: 'claude-code',
      branch,
      values: {
        agenticToolPresetId: INLINE_AGENTIC_CONFIGURATION,
        modelConfig: { model: 'claude-sonnet' },
        effort: 'low',
      },
    });
    expect(config.agenticToolPresetId).toBeUndefined();
    expect(config.modelConfig).toEqual({ model: 'claude-sonnet', effort: 'low' });
    expect(config.effort).toBeUndefined();
  });

  it('resolves each Codex field as form value > saved default > permission-mode default', () => {
    const config = buildNewSessionConfig({
      user,
      tool: 'codex',
      branch,
      values: { codexSandboxMode: 'workspace-write' },
    });
    expect(config).toMatchObject({
      permissionMode: 'allow-all',
      codexSandboxMode: 'workspace-write', // form value
      codexApprovalPolicy: 'on-failure', // saved default
      codexNetworkAccess: true, // derived from allow-all
    });
  });

  it('omits Codex fields for other tools and drops an empty attachment list', () => {
    const config = buildNewSessionConfig({
      user: null,
      tool: 'claude-code',
      branch,
      attachmentFiles: [],
    });
    expect(config.agenticToolPresetId).toBeUndefined();
    expect('codexSandboxMode' in config).toBe(false);
    expect(config.attachmentFiles).toBeUndefined();
  });
});
