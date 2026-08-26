import type { BranchRepository } from '@agor/core/db/repositories/branches';
import type { MCPServerRepository } from '@agor/core/db/repositories/mcp-servers';
import type { MessagesRepository } from '@agor/core/db/repositories/messages';
import type { SessionMCPServerRepository } from '@agor/core/db/repositories/session-mcp-servers';
import type { SessionRepository } from '@agor/core/db/repositories/sessions';
import type { SessionID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@google/gemini-cli-core', () => ({
  ApprovalMode: { DEFAULT: 'default', AUTO_EDIT: 'autoEdit', YOLO: 'yolo' },
  GeminiEventType: { Error: 'error' },
}));
vi.mock('@agor/core/agentic-integrations', () => ({
  loadManagedAgenticToolSdk: vi.fn(() => import('@google/gemini-cli-core')),
}));

import { GeminiPromptService } from './prompt-service.js';

describe('GeminiPromptService', () => {
  let service: GeminiPromptService;
  let mockMessagesRepo: MessagesRepository;
  let mockSessionsRepo: SessionRepository;
  let mockBranchesRepo: BranchRepository;
  let mockMCPServerRepo: MCPServerRepository;
  let mockSessionMCPRepo: SessionMCPServerRepository;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Create minimal mock repositories
    mockMessagesRepo = {} as MessagesRepository;

    mockSessionsRepo = {
      findById: vi.fn(),
    } as unknown as SessionRepository;

    mockBranchesRepo = {
      findById: vi.fn(),
    } as unknown as BranchRepository;

    mockMCPServerRepo = {
      findAll: vi.fn().mockResolvedValue([]),
    } as unknown as MCPServerRepository;

    mockSessionMCPRepo = {
      findBySessionId: vi.fn().mockResolvedValue([]),
    } as unknown as SessionMCPServerRepository;

    service = new GeminiPromptService(
      mockMessagesRepo,
      mockSessionsRepo,
      undefined,
      mockBranchesRepo,
      undefined, // reposRepo
      mockMCPServerRepo,
      mockSessionMCPRepo,
      false
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should initialize with all dependencies', () => {
      expect(service).toBeInstanceOf(GeminiPromptService);
    });

    it('should initialize with minimal dependencies', () => {
      const minimalService = new GeminiPromptService(mockMessagesRepo, mockSessionsRepo);
      expect(minimalService).toBeInstanceOf(GeminiPromptService);
    });

    it('should accept optional API key', () => {
      const serviceWithKey = new GeminiPromptService(
        mockMessagesRepo,
        mockSessionsRepo,
        'test-api-key'
      );
      expect(serviceWithKey).toBeInstanceOf(GeminiPromptService);
    });

    it('should accept optional MCP configuration', () => {
      const serviceWithMCP = new GeminiPromptService(
        mockMessagesRepo,
        mockSessionsRepo,
        undefined,
        mockBranchesRepo,
        undefined, // reposRepo
        mockMCPServerRepo,
        mockSessionMCPRepo,
        true
      );
      expect(serviceWithMCP).toBeInstanceOf(GeminiPromptService);
    });
  });

  describe('Task Management', () => {
    const sessionId = 'test-session-id-123' as SessionID;

    it('does not start a provider request when stopped during initialization', async () => {
      const sendMessageStream = vi.fn();
      let finishInitialization!: (client: { sendMessageStream: typeof sendMessageStream }) => void;
      const initialization = new Promise<{ sendMessageStream: typeof sendMessageStream }>(
        (resolve) => {
          finishInitialization = resolve;
        }
      );
      const getOrCreateClient = vi.fn().mockReturnValue(initialization);
      (
        service as unknown as {
          getOrCreateClient: typeof getOrCreateClient;
        }
      ).getOrCreateClient = getOrCreateClient;
      vi.mocked(mockSessionsRepo.findById).mockResolvedValue({
        created_by: 'user-1',
        model_config: null,
      } as never);

      const outerAbortController = new AbortController();
      const nextEvent = service
        .promptSessionStreaming(
          sessionId,
          'test prompt',
          undefined,
          undefined,
          undefined,
          outerAbortController.signal
        )
        .next();

      await vi.waitFor(() => expect(getOrCreateClient).toHaveBeenCalledOnce());
      outerAbortController.abort();
      expect(service.stopTask(sessionId)).toEqual({ success: true });
      finishInitialization({ sendMessageStream });

      await expect(nextEvent).resolves.toMatchObject({ done: true });
      expect(sendMessageStream).not.toHaveBeenCalled();
    });

    it('should return failure when stopping non-existent task', () => {
      const result = service.stopTask(sessionId);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('No active task found for this session');
    });

    it('should return consistent failure response for same non-existent session', () => {
      const sessionId = 'missing-session' as SessionID;
      const result1 = service.stopTask(sessionId);
      const result2 = service.stopTask(sessionId);

      expect(result1.success).toBe(false);
      expect(result2.success).toBe(false);
      expect(result1.reason).toBe(result2.reason);
    });

    it('should handle different non-existent sessions independently', () => {
      const sessionId1 = 'session-1' as SessionID;
      const sessionId2 = 'session-2' as SessionID;

      const result1 = service.stopTask(sessionId1);
      const result2 = service.stopTask(sessionId2);

      expect(result1.success).toBe(false);
      expect(result2.success).toBe(false);
    });
  });

  describe('Session Management', () => {
    const sessionId = 'test-session-id-456' as SessionID;

    it('should handle closing non-existent session gracefully', async () => {
      await expect(service.closeSession(sessionId)).resolves.toBeUndefined();
    });

    it('should allow closing same session multiple times without error', async () => {
      await expect(service.closeSession(sessionId)).resolves.toBeUndefined();
      await expect(service.closeSession(sessionId)).resolves.toBeUndefined();
      await expect(service.closeSession(sessionId)).resolves.toBeUndefined();
    });

    it('should handle closing multiple different sessions', async () => {
      const sessionId1 = 'session-1' as SessionID;
      const sessionId2 = 'session-2' as SessionID;
      const sessionId3 = 'session-3' as SessionID;

      await expect(service.closeSession(sessionId1)).resolves.toBeUndefined();
      await expect(service.closeSession(sessionId2)).resolves.toBeUndefined();
      await expect(service.closeSession(sessionId3)).resolves.toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle session not found error in promptSessionStreaming', async () => {
      const sessionId = 'non-existent-session' as SessionID;
      vi.mocked(mockSessionsRepo.findById).mockResolvedValue(null);

      const generator = service.promptSessionStreaming(sessionId, 'test prompt');

      await expect(generator.next()).rejects.toThrow(`Session ${sessionId} not found`);
    });

    it('should return failure for missing session in stopTask', () => {
      const sessionId = 'missing-session' as SessionID;
      const result = service.stopTask(sessionId);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('No active task found');
    });

    it('should handle multiple error calls consistently', async () => {
      const sessionId = 'non-existent' as SessionID;
      vi.mocked(mockSessionsRepo.findById).mockResolvedValue(null);

      const gen1 = service.promptSessionStreaming(sessionId, 'test 1');
      const gen2 = service.promptSessionStreaming(sessionId, 'test 2');

      await expect(gen1.next()).rejects.toThrow('not found');
      await expect(gen2.next()).rejects.toThrow('not found');
    });

    it('never logs or returns a secret-bearing provider error event', async () => {
      const sessionId = 'provider-error-session' as SessionID;
      const sentinel = 'SENTINEL_GEMINI_PROVIDER_d4c2';
      vi.mocked(mockSessionsRepo.findById).mockResolvedValue({
        created_by: 'user-1',
        model_config: null,
      } as never);
      const sendMessageStream = vi.fn(async function* () {
        yield {
          type: 'error',
          value: new Error(`TLS failure for https://${sentinel}.example.test`),
        };
      });
      (
        service as unknown as {
          getOrCreateClient: () => Promise<{ sendMessageStream: typeof sendMessageStream }>;
        }
      ).getOrCreateClient = vi.fn().mockResolvedValue({ sendMessageStream });
      const spies = [
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
        vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      ];

      try {
        const failure = await service
          .promptSessionStreaming(sessionId, 'test prompt')
          .next()
          .catch((error: unknown) => error);
        expect(String(failure)).not.toContain(sentinel);
        expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(sentinel);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });

  describe('Public API Behavior', () => {
    it('should expose stopTask method', () => {
      expect(service.stopTask).toBeInstanceOf(Function);
    });

    it('should expose closeSession method', () => {
      expect(service.closeSession).toBeInstanceOf(Function);
    });

    it('should expose promptSessionStreaming method', () => {
      expect(service.promptSessionStreaming).toBeInstanceOf(Function);
    });

    it('should return proper types from stopTask', () => {
      const result = service.stopTask('test' as SessionID);
      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');
    });
  });
});
