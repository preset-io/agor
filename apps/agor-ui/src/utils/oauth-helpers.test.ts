import { describe, expect, it } from 'vitest';
import {
  buildOAuthAutoContinuePrompt,
  type PendingOAuthServer,
  shouldProcessOAuthRequired,
} from './oauth-helpers';

describe('buildOAuthAutoContinuePrompt', () => {
  it('returns null when pendingServer is null', () => {
    expect(buildOAuthAutoContinuePrompt(null)).toBeNull();
  });

  it('returns null when pendingServer has no sessionId', () => {
    const server: PendingOAuthServer = {
      serverId: 'srv-1',
      name: 'My MCP',
      url: 'https://mcp.example.com',
    };
    expect(buildOAuthAutoContinuePrompt(server)).toBeNull();
  });

  it('returns correct prompt payload when sessionId is present', () => {
    const server: PendingOAuthServer = {
      serverId: 'srv-1',
      name: 'My MCP',
      url: 'https://mcp.example.com',
      sessionId: 'session-abc',
    };
    const result = buildOAuthAutoContinuePrompt(server);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-abc');
    expect(result!.prompt).toContain('My MCP');
    expect(result!.prompt).toContain('OAuth authentication');
    expect(result!.prompt).toContain('continue with what you were doing');
    expect(result!.messageSource).toBe('agor');
  });
});

describe('shouldProcessOAuthRequired', () => {
  it('returns true when idle (no pending server, no cooldown)', () => {
    const result = shouldProcessOAuthRequired(null, 0, 1000);
    expect(result.shouldProcess).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns false when a flow is already in progress', () => {
    const pending: PendingOAuthServer = {
      serverId: 'srv-1',
      name: 'Test',
      url: 'https://test.com',
    };
    const result = shouldProcessOAuthRequired(pending, 0, 1000);
    expect(result.shouldProcess).toBe(false);
    expect(result.reason).toContain('already in progress');
  });

  it('returns false during cooldown period', () => {
    const cooldownUntil = 5000;
    const result = shouldProcessOAuthRequired(null, cooldownUntil, 3000);
    expect(result.shouldProcess).toBe(false);
    expect(result.reason).toContain('cooldown');
  });

  it('returns true after cooldown expires', () => {
    const cooldownUntil = 5000;
    const result = shouldProcessOAuthRequired(null, cooldownUntil, 6000);
    expect(result.shouldProcess).toBe(true);
  });
});
