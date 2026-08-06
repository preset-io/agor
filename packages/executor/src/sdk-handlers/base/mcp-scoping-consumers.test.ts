import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const consumers = [
  '../claude/query-builder.ts',
  '../codex/prompt-service.ts',
  '../gemini/prompt-service.ts',
  '../../handlers/sdk/opencode.ts',
  '../../handlers/sdk/cursor.ts',
  '../copilot/prompt-service.ts',
] as const;

describe('agentic-tool MCP scoping', () => {
  it.each(consumers)(
    '%s consumes the shared usable MCP set without an identity override',
    (file) => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      expect(source).toContain('getMcpServersForSession(');
      expect(source).not.toContain('forUserId:');
    }
  );
});
