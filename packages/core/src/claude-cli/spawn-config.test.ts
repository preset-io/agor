import { describe, expect, it } from 'vitest';
import {
  buildClaudeCliSpawn,
  formatAsShellCommand,
  formatForZellijNewTab,
} from './spawn-config.js';

describe('buildClaudeCliSpawn', () => {
  it('emits --session-id when provided', () => {
    const { bin, args } = buildClaudeCliSpawn({ sessionId: 'abc-123' });
    expect(bin).toBe('claude');
    expect(args).toEqual(['--session-id', 'abc-123']);
  });

  it('prefers --resume over --session-id when both supplied', () => {
    const { args } = buildClaudeCliSpawn({
      sessionId: 'should-be-ignored',
      resumeSessionId: 'parent-uuid',
      forkSession: true,
    });
    expect(args).toContain('--resume');
    expect(args).toContain('parent-uuid');
    expect(args).toContain('--fork-session');
    expect(args).not.toContain('--session-id');
  });

  it('strips [1m] from model and appends --betas context-1m-2025-08-07', () => {
    const { args } = buildClaudeCliSpawn({ model: 'claude-opus-4-7[1m]' });
    const i = args.indexOf('--model');
    expect(args[i + 1]).toBe('claude-opus-4-7');
    expect(args).toContain('--betas');
    const j = args.indexOf('--betas');
    expect(args[j + 1]).toBe('context-1m-2025-08-07');
  });

  it('emits --dangerously-skip-permissions instead of --permission-mode when chosen', () => {
    const { args } = buildClaudeCliSpawn({
      permissionMode: 'dangerously-skip-permissions',
    });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('emits --permission-mode acceptEdits for the default-friendly mode', () => {
    const { args } = buildClaudeCliSpawn({ permissionMode: 'acceptEdits' });
    const i = args.indexOf('--permission-mode');
    expect(args[i + 1]).toBe('acceptEdits');
  });

  it('drops unknown permission modes silently', () => {
    const { args } = buildClaudeCliSpawn({
      permissionMode: 'totally-made-up' as 'default',
    });
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('emits --mcp-config plus --strict-mcp-config by default', () => {
    const { args } = buildClaudeCliSpawn({ mcpConfigPath: '/tmp/agor-mcp-x.json' });
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/agor-mcp-x.json');
    expect(args).toContain('--strict-mcp-config');
  });

  it('omits --strict-mcp-config when strictMcp:false', () => {
    const { args } = buildClaudeCliSpawn({
      mcpConfigPath: '/tmp/agor-mcp-x.json',
      strictMcp: false,
    });
    expect(args).toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('emits --add-dir with multiple paths', () => {
    const { args } = buildClaudeCliSpawn({ addDirs: ['/repo/a', '/repo/b'] });
    const i = args.indexOf('--add-dir');
    expect(args.slice(i + 1, i + 3)).toEqual(['/repo/a', '/repo/b']);
  });

  it('builds a full realistic spawn', () => {
    const { args } = buildClaudeCliSpawn({
      sessionId: '019e2747-cd3c-7669-af2e-aeb5b1e80ed9',
      model: 'claude-opus-4-7[1m]',
      effort: 'high',
      permissionMode: 'acceptEdits',
      mcpConfigPath: '/tmp/agor-mcp-019e2747.json',
      addDirs: ['/repo'],
      appendSystemPromptFile: '/tmp/agor-syscontext-019e2747.txt',
      displayName: 'cli-019e2747',
    });
    expect(args).toEqual([
      '--session-id',
      '019e2747-cd3c-7669-af2e-aeb5b1e80ed9',
      '-n',
      'cli-019e2747',
      '--model',
      'claude-opus-4-7',
      '--betas',
      'context-1m-2025-08-07',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
      '--mcp-config',
      '/tmp/agor-mcp-019e2747.json',
      '--strict-mcp-config',
      '--add-dir',
      '/repo',
      '--append-system-prompt-file',
      '/tmp/agor-syscontext-019e2747.txt',
    ]);
  });
});

describe('formatForZellijNewTab', () => {
  it('produces alternating --args entries for each argv element', () => {
    const built = buildClaudeCliSpawn({ sessionId: 'abc', model: 'claude-sonnet-4-6' });
    expect(formatForZellijNewTab(built)).toEqual([
      '--command',
      'claude',
      '--args',
      '--session-id',
      '--args',
      'abc',
      '--args',
      '--model',
      '--args',
      'claude-sonnet-4-6',
    ]);
  });
});

describe('formatAsShellCommand', () => {
  it('quotes argv elements with embedded spaces', () => {
    const built = buildClaudeCliSpawn({
      sessionId: 'abc',
      addDirs: ['/path with space'],
    });
    const rendered = formatAsShellCommand(built);
    expect(rendered).toContain("'/path with space'");
    expect(rendered).toMatch(/^claude --session-id abc/);
  });

  it('escapes embedded single quotes', () => {
    const built = buildClaudeCliSpawn({
      sessionId: "with'quote",
    });
    expect(formatAsShellCommand(built)).toContain(`'with'\\''quote'`);
  });
});
