import { describe, expect, it } from 'vitest';
import {
  detectThinkingLevel,
  resolveThinkingBudget,
  THINKING_BUDGETS,
  type ThinkingLevel,
} from './thinking-detector';

describe('detectThinkingLevel', () => {
  describe('ultrathink level (31,999 tokens)', () => {
    it('detects "ultrathink" keyword', () => {
      expect(detectThinkingLevel('please ultrathink this problem')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['ultrathink'],
      });
    });

    it('detects "think harder"', () => {
      expect(detectThinkingLevel('think harder about the architecture')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think harder'],
      });
    });

    it('detects "think very hard"', () => {
      expect(detectThinkingLevel('please think very hard about this')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think very hard'],
      });
    });

    it('detects "think super hard"', () => {
      expect(detectThinkingLevel('think super hard')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think super hard'],
      });
    });

    it('detects "think really hard"', () => {
      expect(detectThinkingLevel('think really hard')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think really hard'],
      });
    });

    it('detects "think intensely"', () => {
      expect(detectThinkingLevel('think intensely')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think intensely'],
      });
    });

    it('detects "think longer"', () => {
      expect(detectThinkingLevel('think longer about this')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think longer'],
      });
    });
  });

  describe('megathink level (10,000 tokens)', () => {
    it('detects "think hard"', () => {
      expect(detectThinkingLevel('think hard about this refactor')).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['think hard'],
      });
    });

    it('detects "think deeply"', () => {
      expect(detectThinkingLevel('please think deeply')).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['think deeply'],
      });
    });

    it('detects "think more"', () => {
      expect(detectThinkingLevel('think more about this')).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['think more'],
      });
    });

    it('detects "think a lot"', () => {
      expect(detectThinkingLevel('think a lot')).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['think a lot'],
      });
    });

    it('detects "think about it"', () => {
      expect(detectThinkingLevel('please think about it carefully')).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['think about it'],
      });
    });
  });

  describe('think level (4,000 tokens)', () => {
    it('detects standalone "think"', () => {
      expect(detectThinkingLevel('please think about the best approach')).toEqual({
        level: 'think',
        tokens: 4000,
        detectedPhrases: ['think'],
      });
    });

    it('detects "think" at start', () => {
      expect(detectThinkingLevel('think before implementing')).toEqual({
        level: 'think',
        tokens: 4000,
        detectedPhrases: ['think'],
      });
    });

    it('detects "think" at end', () => {
      expect(detectThinkingLevel('take time to think')).toEqual({
        level: 'think',
        tokens: 4000,
        detectedPhrases: ['think'],
      });
    });
  });

  describe('none level (0 tokens)', () => {
    it('returns none when no keywords present', () => {
      expect(detectThinkingLevel('implement user authentication')).toEqual({
        level: 'none',
        tokens: 0,
        detectedPhrases: [],
      });
    });

    it('returns none for unrelated text', () => {
      expect(detectThinkingLevel('create a new feature for dashboard')).toEqual({
        level: 'none',
        tokens: 0,
        detectedPhrases: [],
      });
    });

    it('returns none for empty prompt', () => {
      expect(detectThinkingLevel('')).toEqual({
        level: 'none',
        tokens: 0,
        detectedPhrases: [],
      });
    });
  });

  describe('case insensitivity', () => {
    it('detects UPPERCASE keywords', () => {
      expect(detectThinkingLevel('THINK HARDER about this')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['THINK HARDER'],
      });
    });

    it('detects MixedCase keywords', () => {
      expect(detectThinkingLevel('Think Hard about the solution')).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['Think Hard'],
      });
    });

    it('detects lowercase keywords', () => {
      expect(detectThinkingLevel('ultrathink this problem')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['ultrathink'],
      });
    });
  });

  describe('priority when multiple keywords present', () => {
    it('prioritizes ultrathink over megathink', () => {
      expect(detectThinkingLevel('think hard and think harder')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think harder'],
      });
    });

    it('prioritizes ultrathink over think', () => {
      expect(detectThinkingLevel('think and ultrathink this problem')).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['ultrathink'],
      });
    });

    it('prioritizes megathink over think', () => {
      expect(detectThinkingLevel('think deeply and just think')).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['think deeply'],
      });
    });
  });

  describe('word boundaries', () => {
    it('does NOT match "thinking" as "think"', () => {
      // Word boundary \b prevents matching "think" within "thinking"
      // This is correct - "thinking" should not trigger thinking mode
      const result = detectThinkingLevel('I am thinking about the architecture');
      expect(result.level).toBe('none');
      expect(result.tokens).toBe(0);
    });

    it('does NOT match "rethink" as "think"', () => {
      // Word boundary \b prevents matching "think" within "rethink"
      // This is correct - "rethink" should not trigger thinking mode
      const result = detectThinkingLevel('let me rethink this approach');
      expect(result.level).toBe('none');
      expect(result.tokens).toBe(0);
    });

    it('matches "think" in middle of sentence', () => {
      expect(detectThinkingLevel('I think we should refactor')).toEqual({
        level: 'think',
        tokens: 4000,
        detectedPhrases: ['think'],
      });
    });
  });

  describe('real-world prompts', () => {
    it('detects in planning prompt', () => {
      const prompt =
        'Before implementing this feature, please think harder about the architectural implications';
      expect(detectThinkingLevel(prompt)).toEqual({
        level: 'ultrathink',
        tokens: 31999,
        detectedPhrases: ['think harder'],
      });
    });

    it('detects in refactoring prompt', () => {
      const prompt = 'Think hard about how to refactor this monolithic service into microservices';
      expect(detectThinkingLevel(prompt)).toEqual({
        level: 'megathink',
        tokens: 10000,
        detectedPhrases: ['Think hard'],
      });
    });

    it('detects in code review prompt', () => {
      const prompt = 'Please think about potential edge cases in this implementation';
      expect(detectThinkingLevel(prompt)).toEqual({
        level: 'think',
        tokens: 4000,
        detectedPhrases: ['think'],
      });
    });

    it('no detection in simple task', () => {
      const prompt = 'Add a button to the dashboard that opens the settings modal';
      expect(detectThinkingLevel(prompt)).toEqual({
        level: 'none',
        tokens: 0,
        detectedPhrases: [],
      });
    });
  });
});

describe('resolveThinkingBudget', () => {
  describe('off mode', () => {
    it('always returns null regardless of prompt', () => {
      expect(resolveThinkingBudget('ultrathink this', { thinkingMode: 'off' })).toBe(null);
      expect(resolveThinkingBudget('think hard', { thinkingMode: 'off' })).toBe(null);
      expect(resolveThinkingBudget('think', { thinkingMode: 'off' })).toBe(null);
      expect(resolveThinkingBudget('no keywords', { thinkingMode: 'off' })).toBe(null);
    });
  });

  describe('manual mode', () => {
    it('uses configured manual tokens', () => {
      expect(
        resolveThinkingBudget('any prompt text', {
          thinkingMode: 'manual',
          manualThinkingTokens: 15000,
        })
      ).toBe(15000);
    });

    it('ignores keywords in prompt', () => {
      expect(
        resolveThinkingBudget('ultrathink this problem', {
          thinkingMode: 'manual',
          manualThinkingTokens: 5000,
        })
      ).toBe(5000);
    });

    it('returns null when no manual tokens configured', () => {
      expect(
        resolveThinkingBudget('some prompt', {
          thinkingMode: 'manual',
        })
      ).toBe(null);
    });

    it('returns null when manual tokens is 0', () => {
      expect(
        resolveThinkingBudget('some prompt', {
          thinkingMode: 'manual',
          manualThinkingTokens: 0,
        })
      ).toBe(null);
    });
  });

  describe('auto mode', () => {
    it('detects ultrathink keywords', () => {
      expect(resolveThinkingBudget('think harder', { thinkingMode: 'auto' })).toBe(31999);
      expect(resolveThinkingBudget('ultrathink', { thinkingMode: 'auto' })).toBe(31999);
    });

    it('detects megathink keywords', () => {
      expect(resolveThinkingBudget('think hard', { thinkingMode: 'auto' })).toBe(10000);
      expect(resolveThinkingBudget('think deeply', { thinkingMode: 'auto' })).toBe(10000);
    });

    it('detects think keywords', () => {
      expect(resolveThinkingBudget('please think', { thinkingMode: 'auto' })).toBe(4000);
    });

    it('returns null when no keywords detected (CLI behavior)', () => {
      expect(resolveThinkingBudget('implement feature', { thinkingMode: 'auto' })).toBe(null);
      expect(resolveThinkingBudget('create new component', { thinkingMode: 'auto' })).toBe(null);
    });
  });

  describe('default mode (auto)', () => {
    it('defaults to auto when no mode specified', () => {
      expect(resolveThinkingBudget('think harder', {})).toBe(31999);
      expect(resolveThinkingBudget('implement feature', {})).toBe(null);
    });
  });

  describe('edge cases', () => {
    it('handles empty prompt', () => {
      expect(resolveThinkingBudget('', { thinkingMode: 'auto' })).toBe(null);
    });

    it('handles undefined config', () => {
      expect(resolveThinkingBudget('think', {})).toBe(4000);
    });

    it('handles invalid mode (falls back to null)', () => {
      expect(resolveThinkingBudget('think', { thinkingMode: 'invalid' as 'auto' })).toBe(null);
    });
  });
});

describe('THINKING_BUDGETS constants', () => {
  it('has correct token allocations', () => {
    expect(THINKING_BUDGETS.none).toBe(0);
    expect(THINKING_BUDGETS.think).toBe(4000);
    expect(THINKING_BUDGETS.megathink).toBe(10000);
    expect(THINKING_BUDGETS.ultrathink).toBe(31999);
  });

  it('has all thinking levels defined', () => {
    const levels: ThinkingLevel[] = ['none', 'think', 'megathink', 'ultrathink'];
    for (const level of levels) {
      expect(THINKING_BUDGETS[level]).toBeDefined();
      expect(typeof THINKING_BUDGETS[level]).toBe('number');
    }
  });
});
