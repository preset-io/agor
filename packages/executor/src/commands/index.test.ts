/**
 * Tests for command router
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/agentic-tool-opencode/runtime', () => ({
  isOpenCodeCleanupUnverifiedError: () => false,
  OpenCodeTool: class {},
  OPENCODE_AUXILIARY_ADAPTER: {
    async execute() {
      return { success: true, data: { dryRun: true } };
    },
    async executeInteractive(input: { request?: { operation?: string }; dryRun?: boolean }) {
      return {
        success: true,
        data: { dryRun: Boolean(input.dryRun), operation: input.request?.operation },
      };
    },
  },
}));

import type {
  EnvironmentLifecyclePayload,
  GitBranchAddPayload,
  GitBranchRemovePayload,
  GitClonePayload,
  PromptPayload,
  ZellijAttachPayload,
} from '../payload-types.js';
import {
  executeCommand,
  executeInteractiveCommand,
  getRegisteredCommands,
  hasCommand,
} from './index.js';

describe('Command Registry', () => {
  it('should have all expected commands registered', () => {
    const commands = getRegisteredCommands();
    expect(commands).toContain('prompt');
    expect(commands).toContain('git.clone');
    expect(commands).toContain('git.branch.add');
    expect(commands).toContain('git.branch.remove');
    expect(commands).toContain('branch.files.list');
    expect(commands).toContain('branch.files.browse');
    expect(commands).toContain('branch.files.read');
    expect(commands).toContain('branch.filesystem.status');
    expect(commands).toContain('branch.artifact.publish');
    expect(commands).toContain('branch.artifact.land');
    expect(commands).toContain('branch.artifact.validate');
    expect(commands).toContain('branch.knowledge.write');
    expect(commands).toContain('branch.knowledge.read');
    expect(commands).toContain('branch.gateway.slack-file-upload');
    expect(commands).toContain('branch.upload.materialize');
    expect(commands).toContain('branch.agor-yml.import');
    expect(commands).toContain('branch.agor-yml.export');
    expect(commands).toContain('environment.lifecycle');
    expect(commands).toContain('environment.logs');
    expect(commands).toContain('git.repo.realign-origin');
    expect(commands).toContain('git.repo.delete');
    expect(commands).toContain('zellij.attach');
  });

  it('hasCommand should return true for registered commands', () => {
    expect(hasCommand('prompt')).toBe(true);
    expect(hasCommand('git.clone')).toBe(true);
    expect(hasCommand('git.branch.add')).toBe(true);
    expect(hasCommand('git.branch.remove')).toBe(true);
    expect(hasCommand('branch.files.list')).toBe(true);
    expect(hasCommand('branch.files.browse')).toBe(true);
    expect(hasCommand('branch.files.read')).toBe(true);
    expect(hasCommand('branch.filesystem.status')).toBe(true);
    expect(hasCommand('branch.artifact.publish')).toBe(true);
    expect(hasCommand('branch.artifact.land')).toBe(true);
    expect(hasCommand('branch.artifact.validate')).toBe(true);
    expect(hasCommand('branch.knowledge.write')).toBe(true);
    expect(hasCommand('branch.knowledge.read')).toBe(true);
    expect(hasCommand('branch.gateway.slack-file-upload')).toBe(true);
    expect(hasCommand('branch.upload.materialize')).toBe(true);
    expect(hasCommand('branch.agor-yml.import')).toBe(true);
    expect(hasCommand('branch.agor-yml.export')).toBe(true);
    expect(hasCommand('environment.lifecycle')).toBe(true);
    expect(hasCommand('environment.logs')).toBe(true);
    expect(hasCommand('git.repo.realign-origin')).toBe(true);
    expect(hasCommand('git.repo.delete')).toBe(true);
    expect(hasCommand('zellij.attach')).toBe(true);
  });

  it('hasCommand should return false for unregistered commands', () => {
    expect(hasCommand('unknown')).toBe(false);
    expect(hasCommand('git.push')).toBe(false);
    expect(hasCommand('')).toBe(false);
  });
});

describe('executeCommand - environment.lifecycle', () => {
  const payload: EnvironmentLifecyclePayload = {
    command: 'environment.lifecycle',
    sessionToken: 'jwt-token',
    params: {
      branchId: '550e8400-e29b-41d4-a716-446655440000',
      branchPath: '/data/agor/worktrees/repo/feature-x',
      action: 'start',
      startCommand: 'docker compose up -d --build',
      appUrl: 'http://localhost:3000',
    },
  };

  it('should handle environment.lifecycle in dry-run mode', async () => {
    const result = await executeCommand(payload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'environment.lifecycle',
      action: 'start',
      branchId: payload.params.branchId,
    });
  });
});

describe('executeCommand - environment.logs', () => {
  const payload = {
    command: 'environment.logs' as const,
    sessionToken: 'jwt-token',
    params: {
      branchId: '550e8400-e29b-41d4-a716-446655440000',
      branchPath: '/data/agor/worktrees/repo/feature-x',
      logsCommand: 'docker compose logs --tail=100',
    },
  };

  it('should handle environment.logs in dry-run mode', async () => {
    const result = await executeCommand(payload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'environment.logs',
      branchId: payload.params.branchId,
    });
  });
});

describe('executeCommand - prompt', () => {
  const promptPayload: PromptPayload = {
    command: 'prompt',
    sessionToken: 'jwt-token',
    params: {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      taskId: '550e8400-e29b-41d4-a716-446655440001',
      prompt: 'Hello',
      tool: 'claude-code',
      cwd: '/home/user',
    },
  };

  it('should handle prompt command in dry-run mode', async () => {
    const result = await executeCommand(promptPayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'prompt',
      sessionId: promptPayload.params.sessionId,
      taskId: promptPayload.params.taskId,
      tool: 'claude-code',
    });
  });

  it('should delegate prompt command to AgorExecutor', async () => {
    const result = await executeCommand(promptPayload, { dryRun: false });

    // In non-dry-run mode, prompt returns a delegation marker
    // because the actual execution happens through AgorExecutor
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      delegateToExecutor: true,
    });
  });
});

describe('executeCommand - git.clone', () => {
  const gitClonePayload: GitClonePayload = {
    command: 'git.clone',
    sessionToken: 'jwt-token',
    params: {
      url: 'https://github.com/user/repo.git',
      outputPath: '/data/agor/repos/repo.git',
    },
  };

  it('should handle git.clone in dry-run mode', async () => {
    const result = await executeCommand(gitClonePayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'git.clone',
      url: gitClonePayload.params.url,
      outputPath: gitClonePayload.params.outputPath,
    });
  });

  it('should include restore intent in dry-run response', async () => {
    const payloadWithOptions: GitClonePayload = {
      ...gitClonePayload,
      params: {
        ...gitClonePayload.params,
        branch: 'main',
        bare: true,
      },
    };

    const result = await executeCommand(payloadWithOptions, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      branch: 'main',
      bare: true,
    });
  });

  // Regression: the dry-run response must echo `default_branch` so callers
  // can verify the field actually reached the handler — that is the symptom
  // we hit when "Add Repository → Default Branch = X" silently fell back to
  // origin/HEAD because the field was being dropped on the wire upstream.
  it('should echo user-supplied default_branch in dry-run response', async () => {
    const payloadWithDefaultBranch: GitClonePayload = {
      ...gitClonePayload,
      params: {
        ...gitClonePayload.params,
        default_branch: 'release/2024-q1',
      },
    };

    const result = await executeCommand(payloadWithDefaultBranch, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      default_branch: 'release/2024-q1',
    });
  });

  // Note: Non-dry-run tests require a running daemon and are skipped in unit tests
  // Integration tests should cover the full git.clone flow
});

describe('executeCommand - git.branch.add', () => {
  const branchAddPayload: GitBranchAddPayload = {
    command: 'git.branch.add',
    sessionToken: 'jwt-token',
    params: {
      branchId: '550e8400-e29b-41d4-a716-446655440002',
      repoId: '550e8400-e29b-41d4-a716-446655440003',
      materializationAttemptId: '550e8400-e29b-41d4-a716-446655440004',
    },
  };

  it('should handle git.branch.add in dry-run mode', async () => {
    const result = await executeCommand(branchAddPayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'git.branch.add',
    });
  });

  it('should include optional fields in dry-run response', async () => {
    const payloadWithOptions: GitBranchAddPayload = {
      ...branchAddPayload,
      params: {
        ...branchAddPayload.params,
        restoreMode: true,
      },
    };

    const result = await executeCommand(payloadWithOptions, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      restoreMode: true,
    });
  });

  it('should round-trip the clone reference policy in dry-run response', async () => {
    const clonePayload: GitBranchAddPayload = {
      ...branchAddPayload,
      params: {
        ...branchAddPayload.params,
        useReference: true,
      },
    };

    const result = await executeCommand(clonePayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      useReference: true,
    });
  });
});

describe('executeCommand - git.branch.remove', () => {
  const branchRemovePayload: GitBranchRemovePayload = {
    command: 'git.branch.remove',
    sessionToken: 'jwt-token',
    params: {
      branchId: '550e8400-e29b-41d4-a716-446655440002',
      branchPath: '/data/agor/worktrees/repo/feature-x',
      branchesRoot: '/data/agor/worktrees',
    },
  };

  it('should handle git.branch.remove in dry-run mode', async () => {
    const result = await executeCommand(branchRemovePayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'git.branch.remove',
      branchPath: branchRemovePayload.params.branchPath,
    });
  });

  it('should include force option in dry-run response', async () => {
    const payloadWithForce: GitBranchRemovePayload = {
      ...branchRemovePayload,
      params: {
        ...branchRemovePayload.params,
        force: true,
      },
    };

    const result = await executeCommand(payloadWithForce, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      force: true,
    });
  });

  it('should round-trip storageMode in dry-run response', async () => {
    // The daemon-side branches service reads storage_mode from the DB row
    // and forwards it; the executor's remove handler uses it to pick the
    // teardown path (clone-mode = rm -rf, worktree-mode = git worktree
    // remove --force). Pin the round-trip so the contract stays explicit.
    const clonePayload: GitBranchRemovePayload = {
      ...branchRemovePayload,
      params: {
        ...branchRemovePayload.params,
        storageMode: 'clone',
      },
    };

    const result = await executeCommand(clonePayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      storageMode: 'clone',
    });
  });
});

describe('executeCommand - zellij.attach', () => {
  const zellijPayload: ZellijAttachPayload = {
    command: 'zellij.attach',
    sessionToken: 'jwt-token',
    params: {
      userId: '550e8400-e29b-41d4-a716-446655440000',
      sessionName: 'agor-session-123',
      cwd: '/data/agor/worktrees/repo/feature-x',
    },
  };

  it('should handle zellij.attach in dry-run mode', async () => {
    const result = await executeCommand(zellijPayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'zellij.attach',
      userId: zellijPayload.params.userId,
      sessionName: zellijPayload.params.sessionName,
      cwd: zellijPayload.params.cwd,
    });
  });

  // Note: Non-dry-run execution requires daemon connection and node-pty
  // which are not available in unit tests. Integration tests cover this.

  it('should include optional fields in dry-run response', async () => {
    const payloadWithOptions: ZellijAttachPayload = {
      ...zellijPayload,
      params: {
        ...zellijPayload.params,
        tabName: 'feature-x',
        cols: 120,
        rows: 40,
      },
    };

    const result = await executeCommand(payloadWithOptions, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      tabName: 'feature-x',
      cols: 120,
      rows: 40,
    });
  });
});

describe('executeCommand - unknown command', () => {
  it('should return UNKNOWN_COMMAND error for unregistered commands', async () => {
    // We need to bypass TypeScript's type checking for this test
    const unknownPayload = {
      command: 'unknown.command',
      sessionToken: 'jwt-token',
      params: {},
    } as any;

    const result = await executeCommand(unknownPayload);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_COMMAND');
    expect(result.error?.message).toContain('unknown.command');
    expect(result.error?.details).toHaveProperty('supportedCommands');
  });
});

describe('interactive command registry', () => {
  it('routes bounded OpenCode OAuth through the generic transport contract', async () => {
    const result = await executeInteractiveCommand(
      {
        command: 'agentic-tool.invoke',
        agenticToolContext: { dataHome: '/opaque/data-home' },
        params: {
          tool: 'opencode',
          request: {
            operation: 'connect-oauth',
            providerId: 'openai',
            method: 0,
          },
        },
      },
      { dryRun: true },
      {
        emit() {},
        async read() {
          throw new Error('dry-run must not read a control frame');
        },
      }
    );

    expect(result).toEqual({
      success: true,
      data: {
        dryRun: true,
        operation: 'connect-oauth',
      },
    });
  });

  it('rejects interactive operations for tools without an auxiliary adapter', async () => {
    const result = await executeInteractiveCommand(
      {
        command: 'agentic-tool.invoke',
        params: { tool: 'codex', request: { operation: 'discover' } },
      },
      {},
      { emit() {}, async read() {} }
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'AGENTIC_TOOL_AUXILIARY_UNSUPPORTED' },
    });
  });
});

describe('executeCommand - error handling', () => {
  // Git commands now require daemon connection, so non-dry-run calls will fail
  // with connection errors. This verifies error structure is correct.
  it('should have proper error structure for git commands without daemon', async () => {
    const payload: GitClonePayload = {
      command: 'git.clone',
      sessionToken: 'jwt-token',
      daemonUrl: 'http://localhost:99999', // Non-existent port
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/repos/repo.git',
      },
    };

    const result = await executeCommand(payload, { dryRun: false });

    // Should fail due to connection error (no daemon running on port 99999)
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error?.code).toBe('string');
    expect(typeof result.error?.message).toBe('string');
  });
});
