/**
 * CodexPromptService Tests
 *
 * Focused test: Verify SDK instance caching to prevent memory leak (issue #133)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexPromptService } from './prompt-service';

// Mock @openai/codex-sdk to avoid spawning real processes
vi.mock('@openai/codex-sdk', () => {
  // Track how many Codex instances were created
  let instanceCount = 0;

  class MockCodex {
    apiKey: string;
    instanceId: number;

    constructor(options: { apiKey?: string }) {
      this.apiKey = options.apiKey || '';
      this.instanceId = ++instanceCount;
    }

    startThread() {
      return {
        id: 'mock-thread-id',
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: [] }),
      };
    }

    resumeThread(threadId: string) {
      return {
        id: threadId,
        run: vi.fn(),
        runStreamed: vi.fn().mockResolvedValue({ events: [] }),
      };
    }
  }

  return {
    Codex: MockCodex,
    // Helper to get instance count for testing
    __getInstanceCount: () => instanceCount,
    __resetInstanceCount: () => {
      instanceCount = 0;
    },
  };
});

// Import after mocking
const { Codex, __getInstanceCount, __resetInstanceCount } = await import('@openai/codex-sdk');

// Mock repositories and database
const mockMessagesRepo = {} as any;
const mockSessionsRepo = {
  findById: vi.fn(),
} as any;
const mockSessionMCPServerRepo = {
  listServers: vi.fn().mockResolvedValue([]),
} as any;
const mockWorktreesRepo = {
  findById: vi.fn(),
} as any;
const mockDb = {} as any;

describe('CodexPromptService - SDK Instance Caching (issue #133)', () => {
  beforeEach(() => {
    __resetInstanceCount();
    vi.clearAllMocks();
  });

  it('should create exactly one Codex instance on initialization', () => {
    const initialCount = __getInstanceCount();

    new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      'test-api-key',
      mockDb
    );

    expect(__getInstanceCount()).toBe(initialCount + 1);
  });

  it('should reuse the same Codex instance when API key has not changed', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      'test-api-key',
      mockDb
    );

    const countAfterInit = __getInstanceCount();

    // Simulate multiple calls to refreshClient with the same API key
    // Access private method via type assertion for testing
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('test-api-key');
    serviceWithPrivate.refreshClient('test-api-key');
    serviceWithPrivate.refreshClient('test-api-key');

    // Should NOT create new instances - still same count
    expect(__getInstanceCount()).toBe(countAfterInit);
  });

  it('should create a new Codex instance only when API key changes', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      'initial-key',
      mockDb
    );

    const countAfterInit = __getInstanceCount();

    // Call with same API key - should NOT create new instance
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('initial-key');
    expect(__getInstanceCount()).toBe(countAfterInit);

    // Call with different API key - SHOULD create new instance
    serviceWithPrivate.refreshClient('new-api-key');
    expect(__getInstanceCount()).toBe(countAfterInit + 1);

    // Call with same new key again - should NOT create another instance
    serviceWithPrivate.refreshClient('new-api-key');
    expect(__getInstanceCount()).toBe(countAfterInit + 1);
  });

  it('should handle empty/undefined API keys correctly', () => {
    const service = new CodexPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      mockSessionMCPServerRepo,
      mockWorktreesRepo,
      undefined,
      mockDb
    );

    const countAfterInit = __getInstanceCount();

    // Call with empty string - should not recreate if already empty
    const serviceWithPrivate = service as any;
    serviceWithPrivate.refreshClient('');
    expect(__getInstanceCount()).toBe(countAfterInit);

    // Call with actual key - should create new instance
    serviceWithPrivate.refreshClient('new-key');
    expect(__getInstanceCount()).toBe(countAfterInit + 1);
  });
});
