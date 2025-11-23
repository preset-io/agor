import { describe, expect, it } from 'vitest';
import { convertConversationToHistory } from './conversation-converter.js';

describe('convertConversationToHistory', () => {
  describe('Basic Conversions', () => {
    it('should convert empty conversation to empty history', () => {
      const conversation = { messages: [] };
      const history = convertConversationToHistory(conversation);
      expect(history).toEqual([]);
    });

    it('should convert user message with text content', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: { text: 'Hello, Gemini!' },
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      expect(history[0]).toEqual({
        role: 'user',
        parts: [{ text: 'Hello, Gemini!' }],
      });
    });

    it('should convert gemini message to model role', () => {
      const conversation = {
        messages: [
          {
            type: 'gemini' as const,
            content: { text: 'Hello, user!' },
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      expect(history[0]).toEqual({
        role: 'model',
        parts: [{ text: 'Hello, user!' }],
      });
    });
  });

  describe('Array of Parts', () => {
    it('should handle array of parts', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: [{ text: 'Part 1' }, { text: 'Part 2' }],
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      expect(history[0].parts).toHaveLength(2);
      expect(history[0].parts).toEqual([{ text: 'Part 1' }, { text: 'Part 2' }]);
    });

    it('should handle complex part structures', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: [
              { text: 'Text part' },
              { inlineData: { mimeType: 'image/png', data: 'base64data' } },
            ],
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      const firstMessage = history[0];
      expect(firstMessage).toBeDefined();
      if (firstMessage?.parts) {
        expect(firstMessage.parts).toHaveLength(2);
        expect(firstMessage.parts[0]).toEqual({ text: 'Text part' });
        expect(firstMessage.parts[1]).toHaveProperty('inlineData');
        expect(firstMessage.parts[1]).toEqual({
          inlineData: { mimeType: 'image/png', data: 'base64data' },
        });
      }
    });

    it('should handle empty parts array', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: [],
          },
        ],
      };
      const history = convertConversationToHistory(conversation);
      expect(history).toEqual([]);
    });
  });

  describe('Multi-Turn Conversations', () => {
    it('should handle mixed user and model messages', () => {
      const conversation = {
        messages: [
          { type: 'user' as const, content: { text: 'User message' } },
          { type: 'gemini' as const, content: { text: 'Model response' } },
          { type: 'user' as const, content: { text: 'Follow up' } },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(3);
      expect(history[0].role).toBe('user');
      expect(history[1].role).toBe('model');
      expect(history[2].role).toBe('user');
    });

    it('should preserve message order', () => {
      const conversation = {
        messages: [
          { type: 'user' as const, content: { text: 'Message 1' } },
          { type: 'gemini' as const, content: { text: 'Response 1' } },
          { type: 'user' as const, content: { text: 'Message 2' } },
          { type: 'gemini' as const, content: { text: 'Response 2' } },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(4);
      const msg0 = history[0];
      const msg1 = history[1];
      const msg2 = history[2];
      const msg3 = history[3];
      if (msg0 && msg1 && msg2 && msg3 && msg0.parts && msg1.parts && msg2.parts && msg3.parts) {
        expect(msg0.parts[0]).toEqual({ text: 'Message 1' });
        expect(msg1.parts[0]).toEqual({ text: 'Response 1' });
        expect(msg2.parts[0]).toEqual({ text: 'Message 2' });
        expect(msg3.parts[0]).toEqual({ text: 'Response 2' });
      }
    });

    it('should handle very long conversation histories', () => {
      const messages = Array.from({ length: 1000 }, (_, i) => ({
        type: (i % 2 === 0 ? 'user' : 'gemini') as 'user' | 'gemini',
        content: { text: `Message ${i}` },
      }));
      const conversation = { messages };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1000);
      const first = history[0];
      const last = history[999];
      const second = history[1];
      if (first && last && second && first.parts && last.parts) {
        expect(first.parts[0]).toEqual({ text: 'Message 0' });
        expect(last.parts[0]).toEqual({ text: 'Message 999' });
        expect(first.role).toBe('user');
        expect(second.role).toBe('model');
      }
    });
  });

  describe('Invalid and Edge Cases', () => {
    it('should skip messages with no valid content', () => {
      const conversation = {
        messages: [
          { type: 'user' as const, content: null },
          { type: 'user' as const, content: { text: 'Valid message' } },
          { type: 'user' as const, content: {} },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      const msg = history[0];
      if (msg?.parts) {
        expect(msg.parts[0]).toEqual({ text: 'Valid message' });
      }
    });

    it('should handle messages with undefined content', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: undefined,
          },
        ],
      };
      const history = convertConversationToHistory(conversation);
      expect(history).toEqual([]);
    });

    it('should handle content without text property', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: { notText: 'value' },
          },
        ],
      };
      const history = convertConversationToHistory(conversation);
      expect(history).toEqual([]);
    });

    it('should handle content with non-string text', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: { text: 123 },
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      // Should still include it since it has a 'text' property
      expect(history).toHaveLength(1);
      const msg = history[0];
      if (msg?.parts) {
        expect(msg.parts[0]).toEqual({ text: 123 });
      }
    });

    it('should handle messages with extra properties', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: { text: 'Hello', extraProp: 'ignored' },
            timestamp: '2024-01-01',
            id: 'msg-123',
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      const msg = history[0];
      if (msg?.parts) {
        expect(msg.parts[0]).toHaveProperty('text', 'Hello');
      }
    });
  });

  describe('Pure Function Properties', () => {
    it('should be a pure function (no side effects)', () => {
      const conversation = {
        messages: [{ type: 'user' as const, content: { text: 'Test' } }],
      };

      const result1 = convertConversationToHistory(conversation);
      const result2 = convertConversationToHistory(conversation);

      expect(result1).toEqual(result2);
      expect(result1).not.toBe(result2); // Different array instances
    });

    it('should not mutate input conversation', () => {
      const conversation = {
        messages: [{ type: 'user' as const, content: { text: 'Original' } }],
      };

      const originalMessageCount = conversation.messages.length;
      const originalContent = conversation.messages[0].content;

      convertConversationToHistory(conversation);

      expect(conversation.messages.length).toBe(originalMessageCount);
      expect(conversation.messages[0].content).toBe(originalContent);
    });

    it('should handle repeated calls with same input consistently', () => {
      const conversation = {
        messages: [
          { type: 'user' as const, content: { text: 'Test 1' } },
          { type: 'gemini' as const, content: { text: 'Test 2' } },
        ],
      };

      const results = Array.from({ length: 10 }, () => convertConversationToHistory(conversation));

      // All results should be equal
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toEqual(results[0]);
      }
    });
  });

  describe('Role Conversion', () => {
    it('should always convert "user" type to "user" role', () => {
      const conversation = {
        messages: [
          { type: 'user' as const, content: { text: 'Test 1' } },
          { type: 'user' as const, content: { text: 'Test 2' } },
          { type: 'user' as const, content: { text: 'Test 3' } },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history.every((h) => h.role === 'user')).toBe(true);
    });

    it('should always convert "gemini" type to "model" role', () => {
      const conversation = {
        messages: [
          { type: 'gemini' as const, content: { text: 'Test 1' } },
          { type: 'gemini' as const, content: { text: 'Test 2' } },
          { type: 'gemini' as const, content: { text: 'Test 3' } },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history.every((h) => h.role === 'model')).toBe(true);
    });
  });

  describe('Special Content Types', () => {
    it('should handle functionCall parts', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: 'test.ts' },
                },
              },
            ],
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      const msg = history[0];
      if (msg?.parts) {
        expect(msg.parts[0]).toHaveProperty('functionCall');
      }
    });

    it('should handle functionResponse parts', () => {
      const conversation = {
        messages: [
          {
            type: 'gemini' as const,
            content: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { content: 'file contents' },
                },
              },
            ],
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      const msg = history[0];
      if (msg?.parts) {
        expect(msg.parts[0]).toHaveProperty('functionResponse');
      }
    });

    it('should handle mixed content types in single message', () => {
      const conversation = {
        messages: [
          {
            type: 'user' as const,
            content: [
              { text: 'Please read this file:' },
              { inlineData: { mimeType: 'text/plain', data: 'base64...' } },
              { functionCall: { name: 'read_file', args: { path: 'test.ts' } } },
            ],
          },
        ],
      };
      const history = convertConversationToHistory(conversation);

      expect(history).toHaveLength(1);
      const msg = history[0];
      if (msg?.parts) {
        expect(msg.parts).toHaveLength(3);
        expect(msg.parts[0]).toHaveProperty('text');
        expect(msg.parts[1]).toHaveProperty('inlineData');
        expect(msg.parts[2]).toHaveProperty('functionCall');
      }
    });
  });
});
