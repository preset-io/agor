import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertStatelessFsModeCompatible } from './stateless-fs-compatibility.js';

describe('stateless filesystem compatibility', () => {
  it('rejects OpenCode only when stateless mode is enabled', () => {
    expect(() => assertStatelessFsModeCompatible('opencode', true)).toThrow(
      "stateless_fs_mode is enabled but tool 'opencode' does not support it"
    );
    expect(() => assertStatelessFsModeCompatible('opencode', false)).not.toThrow();
  });

  it('preserves the existing capability policy for every other tool', () => {
    expect(() => assertStatelessFsModeCompatible('claude-code', true)).not.toThrow();
    expect(() => assertStatelessFsModeCompatible('codex', true)).not.toThrow();
    expect(() => assertStatelessFsModeCompatible('gemini', true)).toThrow();
    expect(() => assertStatelessFsModeCompatible('copilot', true)).toThrow();
    expect(() => assertStatelessFsModeCompatible('cursor', true)).toThrow();
    expect(() => assertStatelessFsModeCompatible('claude-code-cli', true)).toThrow();
  });

  it('guards the execute handler before token creation and executor spawn', () => {
    const source = readFileSync(new URL('../register-services.ts', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('function createExecuteHandler('));
    const guardIndex = handler.indexOf('assertStatelessFsModeCompatible(');
    const tokenIndex = handler.indexOf('.generateToken(');
    const spawnIndex = handler.indexOf('\n    spawnExecutor(');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(tokenIndex);
    expect(tokenIndex).toBeLessThan(spawnIndex);
  });
});
