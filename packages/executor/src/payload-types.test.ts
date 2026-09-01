/**
 * Tests for ExecutorPayload types and Zod schemas
 */

import { describe, expect, it } from 'vitest';
import {
  AgenticToolInvokePayloadSchema,
  EnvironmentLifecyclePayloadSchema,
  EnvironmentLogsPayloadSchema,
  ExecutorPayloadSchema,
  GitBranchAddPayloadSchema,
  GitBranchCleanPayloadSchema,
  GitBranchRemovePayloadSchema,
  GitClonePayloadSchema,
  GitRepoDeletePayloadSchema,
  GitRepoRealignOriginPayloadSchema,
  getSupportedCommands,
  isGitBranchAddPayload,
  isGitBranchRemovePayload,
  isGitClonePayload,
  isPromptPayload,
  isZellijAttachPayload,
  PromptPayloadSchema,
  parseExecutorPayload,
  ZellijAttachPayloadSchema,
} from './payload-types.js';

describe('PromptPayloadSchema', () => {
  it('should parse valid prompt payload', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello, world!',
        tool: 'claude-code',
        cwd: '/home/user/project',
      },
    };

    const result = PromptPayloadSchema.parse(payload);
    expect(result.command).toBe('prompt');
    expect(result.sessionToken).toBe('jwt-token-here');
    expect(result.params.tool).toBe('claude-code');
  });

  it('should parse prompt payload with optional fields', () => {
    // Delegated launcher identity is handled at spawn time, not in payload
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      daemonUrl: 'http://localhost:4000',
      env: { ANTHROPIC_API_KEY: 'key' },
      agenticToolContext: { nativeHome: '/data/agor' },
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello!',
        tool: 'gemini',
        permissionMode: 'auto',
        cwd: '/home/user/project',
      },
    };

    const result = PromptPayloadSchema.parse(payload);
    expect(result.daemonUrl).toBe('http://localhost:4000');
    expect(result.env?.ANTHROPIC_API_KEY).toBe('key');
    expect(result.agenticToolContext).toEqual({ nativeHome: '/data/agor' });
    expect(result.params.permissionMode).toBe('auto');
  });

  it('should reject invalid tool type', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello!',
        tool: 'invalid-tool',
        cwd: '/home/user/project',
      },
    };

    expect(() => PromptPayloadSchema.parse(payload)).toThrow();
  });

  it('should reject missing required fields', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt-token-here',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        // missing taskId, prompt, tool, cwd
      },
    };

    expect(() => PromptPayloadSchema.parse(payload)).toThrow();
  });
});

describe('AgenticToolInvokePayloadSchema', () => {
  it('accepts an opaque adapter-owned request and context', () => {
    expect(
      AgenticToolInvokePayloadSchema.parse({
        command: 'agentic-tool.invoke',
        agenticToolContext: { dataHome: '/opaque/data-home' },
        params: {
          tool: 'opencode',
          request: { operation: 'discover', directory: '/authorized/branch' },
        },
      })
    ).toMatchObject({
      params: {
        tool: 'opencode',
        request: { operation: 'discover', directory: '/authorized/branch' },
      },
    });
  });

  it('rejects an unknown agentic tool but leaves request policy to the adapter', () => {
    expect(() =>
      AgenticToolInvokePayloadSchema.parse({
        command: 'agentic-tool.invoke',
        params: { tool: 'unknown', request: { operation: 'anything' } },
      })
    ).toThrow();
    expect(() =>
      AgenticToolInvokePayloadSchema.parse({
        command: 'agentic-tool.invoke',
        params: { tool: 'opencode', request: { operation: 'future-operation' } },
      })
    ).not.toThrow();
  });
});

describe('GitClonePayloadSchema', () => {
  it('should parse valid git.clone payload with HTTPS URL', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/agor/repos/github.com/user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.command).toBe('git.clone');
    expect(result.params.url).toBe('https://github.com/user/repo.git');
  });

  it('should parse git.clone with SSH URL', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'git@github.com:user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('git@github.com:user/repo.git');
  });

  it('should parse git.clone with local path', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: '/home/user/repos/my-repo',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('/home/user/repos/my-repo');
  });

  it('should parse git.clone with git:// protocol', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'git://github.com/user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('git://github.com/user/repo.git');
  });

  it('should parse git.clone with ssh:// protocol', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'ssh://git@github.com/user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.url).toBe('ssh://git@github.com/user/repo.git');
  });

  it('should parse git.clone with optional fields', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/agor/repos/github.com/user/repo.git',
        branch: 'main',
        bare: true,
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.branch).toBe('main');
    expect(result.params.bare).toBe(true);
    expect(result.params.importEnvironmentConfig).toBe(false);
  });

  it('accepts an explicit daemon-derived clone environment-import capability', () => {
    const result = GitClonePayloadSchema.parse({
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'https://github.com/user/repo.git',
        importEnvironmentConfig: true,
      },
    });

    expect(result.params.importEnvironmentConfig).toBe(true);
  });

  it('should reject invalid URL format', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'not-a-valid-url',
      },
    };

    expect(() => GitClonePayloadSchema.parse(payload)).toThrow();
  });

  // Regression: the "Add Repository" form lets the operator pin a non-default
  // base branch (e.g. a long-lived feature branch); the schema must accept it
  // so the route → service → executor chain doesn't drop the field on the wire.
  it('should accept default_branch in params', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'https://github.com/user/repo.git',
        default_branch: 'release/2024-q1',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.default_branch).toBe('release/2024-q1');
  });

  it('should treat default_branch as optional', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt-token-here',
      params: {
        url: 'https://github.com/user/repo.git',
      },
    };

    const result = GitClonePayloadSchema.parse(payload);
    expect(result.params.default_branch).toBeUndefined();
  });
});

describe('EnvironmentLifecyclePayloadSchema', () => {
  it('should parse valid environment start payload', () => {
    const payload = {
      command: 'environment.lifecycle',
      sessionToken: 'jwt-token-here',
      env: { PATH: '/usr/bin:/bin' },
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440000',
        branchPath: '/data/agor/worktrees/repo/feature',
        action: 'start',
        startCommand: 'docker compose up -d --build',
        appUrl: 'http://localhost:3000',
        healthCheckUrl: 'http://localhost:3000/health',
        startupTimeoutMs: 2_700_000,
        lifecycleGeneration: 7,
      },
    };

    const result = EnvironmentLifecyclePayloadSchema.parse(payload);
    expect(result.command).toBe('environment.lifecycle');
    expect(result.params.action).toBe('start');
    expect(result.params.startCommand).toBe('docker compose up -d --build');
    expect(result.params.healthCheckUrl).toBe('http://localhost:3000/health');
    expect(result.params.startupTimeoutMs).toBe(2_700_000);
    expect(result.params.lifecycleGeneration).toBe(7);
  });

  it('should reject start payloads without startCommand', () => {
    expect(() =>
      EnvironmentLifecyclePayloadSchema.parse({
        command: 'environment.lifecycle',
        sessionToken: 'jwt-token-here',
        params: {
          branchId: '550e8400-e29b-41d4-a716-446655440000',
          action: 'start',
        },
      })
    ).toThrow();
  });
});

describe('EnvironmentLogsPayloadSchema', () => {
  it('should parse valid environment logs payload', () => {
    const payload = {
      command: 'environment.logs',
      sessionToken: 'jwt-token-here',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440000',
        branchPath: '/data/agor/worktrees/repo/feature',
        logsCommand: 'docker compose logs --tail=100',
      },
    };

    const result = EnvironmentLogsPayloadSchema.parse(payload);
    expect(result.command).toBe('environment.logs');
    expect(result.params.logsCommand).toBe('docker compose logs --tail=100');
  });
});

describe('GitBranchAddPayloadSchema', () => {
  it('should parse valid git.branch.add payload', () => {
    const payload = {
      command: 'git.branch.add',
      sessionToken: 'jwt-token-here',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440002',
        repoId: '550e8400-e29b-41d4-a716-446655440003',
      },
    };

    const result = GitBranchAddPayloadSchema.parse(payload);
    expect(result.command).toBe('git.branch.add');
    expect(result.params.repoId).toBe('550e8400-e29b-41d4-a716-446655440003');
    expect(result.params.branchId).toBe('550e8400-e29b-41d4-a716-446655440002');
  });

  it('strips duplicated materialization facts and retains operational intent', () => {
    const result = GitBranchAddPayloadSchema.parse({
      command: 'git.branch.add',
      sessionToken: 'jwt-token-here',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440002',
        repoId: '550e8400-e29b-41d4-a716-446655440003',
        branch: 'untrusted',
        storageMode: 'worktree',
        cloneDepth: 100,
        restoreMode: true,
        useReference: true,
      },
    });
    expect(result.params).not.toHaveProperty('branch');
    expect(result.params).not.toHaveProperty('storageMode');
    expect(result.params).not.toHaveProperty('cloneDepth');
    expect(result.params.restoreMode).toBe(true);
    expect(result.params.useReference).toBe(true);
  });
});

describe('GitBranchRemovePayloadSchema', () => {
  it('should parse valid git.branch.remove payload', () => {
    const payload = {
      command: 'git.branch.remove',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440002',
        branchPath: '/data/agor/worktrees/user/repo/feature-x',
        branchesRoot: '/data/agor/worktrees',
      },
    };

    const result = GitBranchRemovePayloadSchema.parse(payload);
    expect(result.command).toBe('git.branch.remove');
    expect(result.params.branchPath).toBe('/data/agor/worktrees/user/repo/feature-x');
    expect(result.params.branchId).toBe('550e8400-e29b-41d4-a716-446655440002');
    expect(result).not.toHaveProperty('sessionToken');
  });

  it('should parse with force option', () => {
    const payload = {
      command: 'git.branch.remove',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440002',
        branchPath: '/data/agor/worktrees/user/repo/feature-x',
        branchesRoot: '/data/agor/worktrees',
        force: true,
      },
    };

    const result = GitBranchRemovePayloadSchema.parse(payload);
    expect(result.params.force).toBe(true);
  });
});

describe('GitBranchCleanPayloadSchema', () => {
  it('accepts only the daemon-authoritative path and needs no Feathers bearer', () => {
    const result = GitBranchCleanPayloadSchema.parse({
      command: 'git.branch.clean',
      params: { branchPath: '/data/agor/worktrees/user/repo/feature-x' },
    });

    expect(result).not.toHaveProperty('sessionToken');
    expect(result.params.branchPath).toContain('feature-x');
  });
});

describe('ZellijAttachPayloadSchema', () => {
  it('should parse valid zellij.attach payload', () => {
    const payload = {
      command: 'zellij.attach',
      sessionToken: 'jwt-token-here',
      params: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        terminalId: '550e8400-e29b-41d4-a716-446655440001',
        channel:
          'tenant/default/user/550e8400-e29b-41d4-a716-446655440000/terminal/550e8400-e29b-41d4-a716-446655440001',
        sessionName: 'agor-session-123',
        cwd: '/data/agor/worktrees/user/repo/feature-x',
      },
    };

    const result = ZellijAttachPayloadSchema.parse(payload);
    expect(result.command).toBe('zellij.attach');
    expect(result.params.sessionName).toBe('agor-session-123');
    expect(result.params.userId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should parse with optional fields', () => {
    const payload = {
      command: 'zellij.attach',
      sessionToken: 'jwt-token-here',
      params: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        terminalId: '550e8400-e29b-41d4-a716-446655440001',
        channel:
          'tenant/default/user/550e8400-e29b-41d4-a716-446655440000/terminal/550e8400-e29b-41d4-a716-446655440001',
        sessionName: 'agor-session-123',
        cwd: '/data/agor/worktrees/user/repo/feature-x',
        tabName: 'feature-x',
        cols: 120,
        rows: 30,
      },
    };

    const result = ZellijAttachPayloadSchema.parse(payload);
    expect(result.params.tabName).toBe('feature-x');
    expect(result.params.cols).toBe(120);
    expect(result.params.rows).toBe(30);
  });
});

describe('ExecutorPayloadSchema (discriminated union)', () => {
  it('should parse prompt command', () => {
    const payload = {
      command: 'prompt',
      sessionToken: 'jwt',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello',
        tool: 'claude-code',
        cwd: '/home/user',
      },
    };

    const result = ExecutorPayloadSchema.parse(payload);
    expect(result.command).toBe('prompt');
  });

  it('should parse git.clone command', () => {
    const payload = {
      command: 'git.clone',
      sessionToken: 'jwt',
      params: {
        url: 'https://github.com/user/repo.git',
        outputPath: '/data/repos/repo.git',
      },
    };

    const result = ExecutorPayloadSchema.parse(payload);
    expect(result.command).toBe('git.clone');
  });

  it('should reject unknown command', () => {
    const payload = {
      command: 'unknown.command',
      sessionToken: 'jwt',
      params: {},
    };

    expect(() => ExecutorPayloadSchema.parse(payload)).toThrow();
  });

  it('requires a versioned response capability in request mode', () => {
    const payload = {
      command: 'branch.files.browse',
      executorMode: 'request',
      sessionToken: 'jwt',
      params: { branchId: '550e8400-e29b-41d4-a716-446655440000' },
    };

    expect(() => ExecutorPayloadSchema.parse(payload)).toThrow(/executor response descriptor/i);
    expect(() =>
      ExecutorPayloadSchema.parse({
        ...payload,
        executorResponse: {
          protocol: 'executor-response-v1',
          profile: 'terminal',
          requestId: '550e8400-e29b-41d4-a716-446655440001',
          url: 'http://daemon.internal:3030/executor/responses/request',
          token: 'a'.repeat(43),
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          maxResponseBytes: 1024,
        },
      })
    ).not.toThrow();
  });

  it('rejects response capabilities on autonomous invocations', () => {
    expect(() =>
      ExecutorPayloadSchema.parse({
        command: 'branch.files.browse',
        executorMode: 'autonomous',
        executorResponse: {
          protocol: 'executor-response-v1',
          profile: 'terminal',
          requestId: '550e8400-e29b-41d4-a716-446655440001',
          url: 'http://daemon.internal:3030/executor/responses/request',
          token: 'a'.repeat(43),
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          maxResponseBytes: 1024,
        },
        sessionToken: 'jwt',
        params: { branchId: '550e8400-e29b-41d4-a716-446655440000' },
      })
    ).toThrow(/request mode/i);
  });
});

describe('parseExecutorPayload', () => {
  it('should parse valid JSON string', () => {
    const json = JSON.stringify({
      command: 'prompt',
      sessionToken: 'jwt',
      params: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        taskId: '550e8400-e29b-41d4-a716-446655440001',
        prompt: 'Hello',
        tool: 'claude-code',
        cwd: '/home/user',
      },
    });

    const result = parseExecutorPayload(json);
    expect(result.command).toBe('prompt');
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseExecutorPayload('not json')).toThrow();
  });

  it('should throw on invalid schema', () => {
    const json = JSON.stringify({
      command: 'prompt',
      // missing required fields
    });

    expect(() => parseExecutorPayload(json)).toThrow();
  });
});

describe('Type guards', () => {
  const promptPayload = {
    command: 'prompt' as const,
    sessionToken: 'jwt',
    params: {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      taskId: '550e8400-e29b-41d4-a716-446655440001',
      prompt: 'Hello',
      tool: 'claude-code' as const,
      cwd: '/home/user',
    },
  };

  const gitClonePayload = {
    command: 'git.clone' as const,
    sessionToken: 'jwt',
    params: {
      url: 'https://github.com/user/repo.git',
      outputPath: '/data/repos/repo.git',
    },
  };

  it('isPromptPayload should identify prompt payloads', () => {
    expect(isPromptPayload(promptPayload)).toBe(true);
    expect(isPromptPayload(gitClonePayload)).toBe(false);
  });

  it('isGitClonePayload should identify git.clone payloads', () => {
    expect(isGitClonePayload(gitClonePayload)).toBe(true);
    expect(isGitClonePayload(promptPayload)).toBe(false);
  });

  it('isGitBranchAddPayload should identify git.branch.add payloads', () => {
    const payload = {
      command: 'git.branch.add' as const,
      sessionToken: 'jwt',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440002',
        repoId: '550e8400-e29b-41d4-a716-446655440003',
      },
    };
    expect(isGitBranchAddPayload(payload)).toBe(true);
    expect(isGitBranchAddPayload(promptPayload)).toBe(false);
  });

  it('isGitBranchRemovePayload should identify git.branch.remove payloads', () => {
    const payload = {
      command: 'git.branch.remove' as const,
      sessionToken: 'jwt',
      params: {
        branchId: '550e8400-e29b-41d4-a716-446655440002',
        branchPath: '/data/branches/feature',
        branchesRoot: '/data/branches',
      },
    };
    expect(isGitBranchRemovePayload(payload)).toBe(true);
    expect(isGitBranchRemovePayload(promptPayload)).toBe(false);
  });

  it('isZellijAttachPayload should identify zellij.attach payloads', () => {
    const payload = {
      command: 'zellij.attach' as const,
      sessionToken: 'jwt',
      params: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        sessionName: 'session-123',
        cwd: '/home/user',
      },
    };
    expect(isZellijAttachPayload(payload)).toBe(true);
    expect(isZellijAttachPayload(promptPayload)).toBe(false);
  });
});

describe('GitRepoDeletePayloadSchema', () => {
  it('requires a daemon-authoritative inventory and no Feathers bearer', () => {
    const result = GitRepoDeletePayloadSchema.parse({
      command: 'git.repo.delete',
      params: {
        repoId: '550e8400-e29b-41d4-a716-446655440000',
        repoPath: '/managed/repos/repo',
        branchPaths: ['/managed/worktrees/repo/feature'],
        reposRoot: '/managed/repos',
        branchesRoot: '/managed/worktrees',
      },
    });

    expect(result).not.toHaveProperty('sessionToken');
    expect(result.params.branchPaths).toEqual(['/managed/worktrees/repo/feature']);
  });
});

describe('GitRepoRealignOriginPayloadSchema', () => {
  it('requires daemon-authoritative filesystem inputs and no Feathers bearer', () => {
    const result = GitRepoRealignOriginPayloadSchema.parse({
      command: 'git.repo.realign-origin',
      params: {
        repoId: '550e8400-e29b-41d4-a716-446655440000',
        repoPath: '/managed/repos/repo',
        remoteUrl: 'https://example.com/org/repo.git',
        repoSlug: 'org/repo',
      },
    });

    expect(result).not.toHaveProperty('sessionToken');
    expect(result.params.repoPath).toBe('/managed/repos/repo');
  });
});

describe('getSupportedCommands', () => {
  it('should return all supported commands', () => {
    const commands = getSupportedCommands();
    expect(commands).toContain('prompt');
    expect(commands).toContain('git.clone');
    expect(commands).toContain('git.branch.add');
    expect(commands).toContain('git.branch.remove');
    expect(commands).toContain('git.branch.clean');
    expect(commands).toContain('git.repo.inspect');
    expect(commands).toContain('git.managed-credentials.reconcile');
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
    expect(commands).toContain('zellij.tab');
    expect(commands).toContain('agentic-tool.invoke');
    expect(commands).toContain('codex.auth-file');
    expect(commands.length).toBe(28);
  });
});
