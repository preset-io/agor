import { describe, expect, it } from 'vitest';
import type { AgenticToolName } from '../types';
import { calculateTokenCost, formatCost, formatTokenCount, type TokenUsage } from './pricing';

describe('calculateTokenCost', () => {
  describe('claude-code', () => {
    const agent: AgenticToolName = 'claude-code';

    it('should calculate cost for input tokens only', () => {
      const usage: TokenUsage = { input_tokens: 1_000_000 };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(3.0); // $3 per 1M input tokens
    });

    it('should calculate cost for output tokens only', () => {
      const usage: TokenUsage = { output_tokens: 1_000_000 };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(15.0); // $15 per 1M output tokens
    });

    it('should calculate cost for input and output tokens', () => {
      const usage: TokenUsage = {
        input_tokens: 500_000,
        output_tokens: 100_000,
      };
      const cost = calculateTokenCost(usage, agent);
      // (500_000 / 1M * $3) + (100_000 / 1M * $15) = $1.50 + $1.50 = $3.00
      expect(cost).toBe(3.0);
    });

    it('should calculate cost with cache read tokens', () => {
      const usage: TokenUsage = {
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_read_tokens: 1_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      // $1.50 + $1.50 + (1M / 1M * $0.30) = $3.30
      expect(cost).toBe(3.3);
    });

    it('should calculate cost with cache creation tokens', () => {
      const usage: TokenUsage = {
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_creation_tokens: 1_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      // $1.50 + $1.50 + (1M / 1M * $3.75) = $6.75
      expect(cost).toBe(6.75);
    });

    it('should calculate cost with all token types', () => {
      const usage: TokenUsage = {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_read_tokens: 2_000_000,
        cache_creation_tokens: 1_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      // $3 + $7.50 + $0.60 + $3.75 = $14.85
      expect(cost).toBe(14.85);
    });

    it('should return zero for zero tokens', () => {
      const usage: TokenUsage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(0);
    });

    it('should handle empty usage object', () => {
      const usage: TokenUsage = {};
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(0);
    });

    it('should handle small token counts', () => {
      const usage: TokenUsage = {
        input_tokens: 1000,
        output_tokens: 500,
      };
      const cost = calculateTokenCost(usage, agent);
      // (1000 / 1M * $3) + (500 / 1M * $15) = $0.003 + $0.0075 = $0.0105
      expect(cost).toBeCloseTo(0.0105);
    });

    it('should handle large token counts', () => {
      const usage: TokenUsage = {
        input_tokens: 50_000_000,
        output_tokens: 10_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      // (50M / 1M * $3) + (10M / 1M * $15) = $150 + $150 = $300
      expect(cost).toBe(300);
    });
  });

  describe('codex', () => {
    const agent: AgenticToolName = 'codex';

    it('should calculate cost for input tokens', () => {
      const usage: TokenUsage = { input_tokens: 1_000_000 };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(10.0); // $10 per 1M input tokens
    });

    it('should calculate cost for output tokens', () => {
      const usage: TokenUsage = { output_tokens: 1_000_000 };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(30.0); // $30 per 1M output tokens
    });

    it('should calculate cost for input and output tokens', () => {
      const usage: TokenUsage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(40.0); // $10 + $30 = $40
    });

    it('should ignore cache tokens (not supported)', () => {
      const usage: TokenUsage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
        cache_creation_tokens: 1_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(40.0); // Only input + output, cache tokens ignored
    });
  });

  describe('gemini', () => {
    const agent: AgenticToolName = 'gemini';

    it('should calculate cost for input tokens', () => {
      const usage: TokenUsage = { input_tokens: 1_000_000 };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(0.075); // $0.075 per 1M input tokens
    });

    it('should calculate cost for output tokens', () => {
      const usage: TokenUsage = { output_tokens: 1_000_000 };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(0.3); // $0.30 per 1M output tokens
    });

    it('should calculate cost for input and output tokens', () => {
      const usage: TokenUsage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(0.375); // $0.075 + $0.30 = $0.375
    });

    it('should ignore cache tokens (not supported)', () => {
      const usage: TokenUsage = {
        input_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
        cache_creation_tokens: 1_000_000,
      };
      const cost = calculateTokenCost(usage, agent);
      expect(cost).toBe(0.075); // Only input tokens
    });

    it('should handle small token counts accurately', () => {
      const usage: TokenUsage = {
        input_tokens: 10_000,
        output_tokens: 5_000,
      };
      const cost = calculateTokenCost(usage, agent);
      // (10_000 / 1M * $0.075) + (5_000 / 1M * $0.30) = $0.00075 + $0.0015 = $0.00225
      expect(cost).toBeCloseTo(0.00225);
    });
  });

  describe('unknown agent', () => {
    it('should return zero and warn for unknown agent', () => {
      const usage: TokenUsage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      };
      // Note: We cast to bypass TypeScript checking since this is testing runtime behavior
      const cost = calculateTokenCost(usage, 'unknown-agent' as AgenticToolName);
      expect(cost).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle undefined token fields', () => {
      const usage: TokenUsage = {
        input_tokens: undefined,
        output_tokens: undefined,
      };
      const cost = calculateTokenCost(usage, 'claude-code');
      expect(cost).toBe(0);
    });

    it('should handle mixed undefined and zero values', () => {
      const usage: TokenUsage = {
        input_tokens: 0,
        output_tokens: undefined,
      };
      const cost = calculateTokenCost(usage, 'claude-code');
      expect(cost).toBe(0);
    });

    it('should handle total_tokens field (informational, not used in calculation)', () => {
      const usage: TokenUsage = {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        total_tokens: 1_500_000,
      };
      const cost = calculateTokenCost(usage, 'claude-code');
      // total_tokens should not affect calculation
      expect(cost).toBe(10.5); // $3 + $7.50 = $10.50
    });

    it('should handle fractional token counts', () => {
      const usage: TokenUsage = {
        input_tokens: 1234.56,
        output_tokens: 789.12,
      };
      const cost = calculateTokenCost(usage, 'claude-code');
      // (1234.56 / 1M * $3) + (789.12 / 1M * $15)
      expect(cost).toBeCloseTo(0.01551504);
    });
  });
});

describe('formatCost', () => {
  it('should format zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('should format very small amounts with 4 decimal places', () => {
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(0.0023)).toBe('$0.0023');
    expect(formatCost(0.0099)).toBe('$0.0099');
  });

  it('should format small amounts with 2 decimal places', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.05)).toBe('$0.05');
    expect(formatCost(0.99)).toBe('$0.99');
  });

  it('should format dollar amounts with 2 decimal places', () => {
    expect(formatCost(1.0)).toBe('$1.00');
    expect(formatCost(12.34)).toBe('$12.34');
    expect(formatCost(99.99)).toBe('$99.99');
  });

  it('should format large amounts with 2 decimal places', () => {
    expect(formatCost(100.0)).toBe('$100.00');
    expect(formatCost(1234.56)).toBe('$1234.56');
    expect(formatCost(999999.99)).toBe('$999999.99');
  });

  it('should round to appropriate precision', () => {
    expect(formatCost(0.00001)).toBe('$0.0000'); // Rounds to 4 decimals
    expect(formatCost(0.00009)).toBe('$0.0001'); // Rounds up
    expect(formatCost(0.0234567)).toBe('$0.02'); // Rounds to 2 decimals when >= 0.01
    expect(formatCost(1.234567)).toBe('$1.23'); // Rounds down
    expect(formatCost(1.235)).toBe('$1.24'); // Rounds up (standard rounding)
  });

  it('should handle negative amounts (edge case)', () => {
    // Note: Negative costs are unlikely in practice but function handles them
    // The function checks if costUsd < 0.01, which includes ALL negative numbers
    expect(formatCost(-0.05)).toBe('$-0.0500'); // < 0.01, uses 4 decimals
    expect(formatCost(-1.23)).toBe('$-1.2300'); // < 0.01, uses 4 decimals
  });

  it('should handle very large numbers', () => {
    expect(formatCost(1000000.0)).toBe('$1000000.00');
    expect(formatCost(9999999.99)).toBe('$9999999.99');
  });

  it('should handle boundary at 0.01', () => {
    expect(formatCost(0.00999)).toBe('$0.0100'); // Just below $0.01, uses 4 decimals
    expect(formatCost(0.01)).toBe('$0.01'); // Exactly $0.01, uses 2 decimals
    expect(formatCost(0.01001)).toBe('$0.01'); // Just above $0.01, uses 2 decimals
  });
});

describe('formatTokenCount', () => {
  it('should format zero', () => {
    expect(formatTokenCount(0)).toBe('0');
  });

  it('should format single digits', () => {
    expect(formatTokenCount(1)).toBe('1');
    expect(formatTokenCount(5)).toBe('5');
    expect(formatTokenCount(9)).toBe('9');
  });

  it('should format hundreds without separators', () => {
    expect(formatTokenCount(100)).toBe('100');
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('should format thousands with separators', () => {
    expect(formatTokenCount(1000)).toBe('1,000');
    expect(formatTokenCount(1234)).toBe('1,234');
    expect(formatTokenCount(9999)).toBe('9,999');
  });

  it('should format tens of thousands', () => {
    expect(formatTokenCount(10000)).toBe('10,000');
    expect(formatTokenCount(12345)).toBe('12,345');
    expect(formatTokenCount(99999)).toBe('99,999');
  });

  it('should format hundreds of thousands', () => {
    expect(formatTokenCount(100000)).toBe('100,000');
    expect(formatTokenCount(123456)).toBe('123,456');
    expect(formatTokenCount(999999)).toBe('999,999');
  });

  it('should format millions', () => {
    expect(formatTokenCount(1000000)).toBe('1,000,000');
    expect(formatTokenCount(1234567)).toBe('1,234,567');
    expect(formatTokenCount(9999999)).toBe('9,999,999');
  });

  it('should format tens of millions', () => {
    expect(formatTokenCount(10000000)).toBe('10,000,000');
    expect(formatTokenCount(12345678)).toBe('12,345,678');
    expect(formatTokenCount(99999999)).toBe('99,999,999');
  });

  it('should format hundreds of millions', () => {
    expect(formatTokenCount(100000000)).toBe('100,000,000');
    expect(formatTokenCount(123456789)).toBe('123,456,789');
  });

  it('should format billions', () => {
    expect(formatTokenCount(1000000000)).toBe('1,000,000,000');
    expect(formatTokenCount(1234567890)).toBe('1,234,567,890');
  });

  it('should handle negative numbers (edge case)', () => {
    expect(formatTokenCount(-1000)).toBe('-1,000');
    expect(formatTokenCount(-1234567)).toBe('-1,234,567');
  });

  it('should handle fractional numbers (edge case)', () => {
    // Note: Token counts should be integers, but toLocaleString handles decimals
    expect(formatTokenCount(1234.56)).toBe('1,234.56');
  });
});
