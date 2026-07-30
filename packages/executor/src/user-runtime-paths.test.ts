import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexAuthPath, resolveEffectiveUserInfo } from './user-runtime-paths.js';

describe('effective executor user paths', () => {
  const originalHome = process.env.HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });
  it('ignores a misleading inherited HOME', () => {
    process.env.HOME = '/home/daemon';
    const lookup = () => ({ homedir: '/home/alice', shell: '/bin/zsh' });
    expect(resolveEffectiveUserInfo(lookup)).toEqual({
      homedir: '/home/alice',
      shell: '/bin/zsh',
    });
    expect(resolveCodexAuthPath(undefined, lookup)).toBe('/home/alice/.codex/auth.json');
  });

  it('honors an explicit executor-scoped CODEX_HOME', () => {
    expect(resolveCodexAuthPath('/runtime/codex', () => ({ homedir: '/wrong', shell: '' }))).toBe(
      '/runtime/codex/auth.json'
    );
  });
});
