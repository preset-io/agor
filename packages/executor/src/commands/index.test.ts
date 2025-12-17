/**
 * Tests for command router
 */

import { describe, expect, it } from 'vitest';
import type {
  GitClonePayload,
  GitWorktreeAddPayload,
  GitWorktreeRemovePayload,
  PromptPayload,
  ZellijAttachPayload,
} from '../payload-types.js';
import { executeCommand, getRegisteredCommands, hasCommand } from './index.js';

describe('Command Registry', () => {
  it('should have all expected commands registered', () => {
    const commands = getRegisteredCommands();
    expect(commands).toContain('prompt');
    expect(commands).toContain('git.clone');
    expect(commands).toContain('git.worktree.add');
    expect(commands).toContain('git.worktree.remove');
    expect(commands).toContain('zellij.attach');
  });

  it('hasCommand should return true for registered commands', () => {
    expect(hasCommand('prompt')).toBe(true);
    expect(hasCommand('git.clone')).toBe(true);
    expect(hasCommand('git.worktree.add')).toBe(true);
    expect(hasCommand('git.worktree.remove')).toBe(true);
    expect(hasCommand('zellij.attach')).toBe(true);
  });

  it('hasCommand should return false for unregistered commands', () => {
    expect(hasCommand('unknown')).toBe(false);
    expect(hasCommand('git.push')).toBe(false);
    expect(hasCommand('')).toBe(false);
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

  it('should return NOT_IMPLEMENTED for git.clone without dry-run', async () => {
    const result = await executeCommand(gitClonePayload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_IMPLEMENTED');
    expect(result.error?.message).toContain('git.clone');
  });

  it('should include optional fields in dry-run response', async () => {
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
});

describe('executeCommand - git.worktree.add', () => {
  const worktreeAddPayload: GitWorktreeAddPayload = {
    command: 'git.worktree.add',
    sessionToken: 'jwt-token',
    params: {
      repoPath: '/data/agor/repos/repo.git',
      worktreeName: 'feature-x',
      worktreePath: '/data/agor/worktrees/repo/feature-x',
    },
  };

  it('should handle git.worktree.add in dry-run mode', async () => {
    const result = await executeCommand(worktreeAddPayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'git.worktree.add',
      repoPath: worktreeAddPayload.params.repoPath,
      worktreeName: worktreeAddPayload.params.worktreeName,
      worktreePath: worktreeAddPayload.params.worktreePath,
    });
  });

  it('should return NOT_IMPLEMENTED for git.worktree.add without dry-run', async () => {
    const result = await executeCommand(worktreeAddPayload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_IMPLEMENTED');
    expect(result.error?.message).toContain('git.worktree.add');
  });
});

describe('executeCommand - git.worktree.remove', () => {
  const worktreeRemovePayload: GitWorktreeRemovePayload = {
    command: 'git.worktree.remove',
    sessionToken: 'jwt-token',
    params: {
      worktreePath: '/data/agor/worktrees/repo/feature-x',
    },
  };

  it('should handle git.worktree.remove in dry-run mode', async () => {
    const result = await executeCommand(worktreeRemovePayload, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      command: 'git.worktree.remove',
      worktreePath: worktreeRemovePayload.params.worktreePath,
    });
  });

  it('should return NOT_IMPLEMENTED for git.worktree.remove without dry-run', async () => {
    const result = await executeCommand(worktreeRemovePayload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_IMPLEMENTED');
    expect(result.error?.message).toContain('git.worktree.remove');
  });

  it('should include force option in dry-run response', async () => {
    const payloadWithForce: GitWorktreeRemovePayload = {
      ...worktreeRemovePayload,
      params: {
        ...worktreeRemovePayload.params,
        force: true,
      },
    };

    const result = await executeCommand(payloadWithForce, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      force: true,
    });
  });
});

describe('executeCommand - zellij.attach', () => {
  const zellijPayload: ZellijAttachPayload = {
    command: 'zellij.attach',
    sessionToken: 'jwt-token',
    params: {
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
      sessionName: zellijPayload.params.sessionName,
      cwd: zellijPayload.params.cwd,
    });
  });

  it('should return NOT_IMPLEMENTED for zellij.attach without dry-run', async () => {
    const result = await executeCommand(zellijPayload, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_IMPLEMENTED');
    expect(result.error?.message).toContain('zellij.attach');
  });

  it('should include optional fields in dry-run response', async () => {
    const payloadWithOptions: ZellijAttachPayload = {
      ...zellijPayload,
      params: {
        ...zellijPayload.params,
        tabName: 'feature-x',
        create: true,
      },
    };

    const result = await executeCommand(payloadWithOptions, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      tabName: 'feature-x',
      create: true,
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

describe('executeCommand - error handling', () => {
  // This test verifies that the command router catches and wraps errors
  // We can't easily test this without mocking, but we verify the structure
  it('should have proper error structure', async () => {
    const payload: GitClonePayload = {
      command: 'git.clone',
      sessionToken: 'jwt-token',
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/repos/repo.git',
      },
    };

    const result = await executeCommand(payload, { dryRun: false });

    // The NOT_IMPLEMENTED error should have proper structure
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error?.code).toBe('string');
    expect(typeof result.error?.message).toBe('string');
  });
});
