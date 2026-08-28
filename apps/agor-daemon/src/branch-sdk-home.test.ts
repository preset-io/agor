import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveBranchSdkHomeLaunch,
  resolveBranchSdkHomeTerminalEnv,
  resolveSdkHomeConfig,
} from './branch-sdk-home.js';

// getBranchHomePath derives from AGOR_DATA_HOME → make the root deterministic.
const DATA_HOME = mkdtempSync(join(tmpdir(), 'agor-sdk-home-test-'));
const priorDataHome = process.env.AGOR_DATA_HOME;
beforeAll(() => {
  process.env.AGOR_DATA_HOME = DATA_HOME;
});
afterAll(() => {
  if (priorDataHome === undefined) delete process.env.AGOR_DATA_HOME;
  else process.env.AGOR_DATA_HOME = priorDataHome;
});

const BRANCH_ID = '0193b1c2-3d4e-7f00-9abc-def012345678';

describe('resolveSdkHomeConfig (design §9.1)', () => {
  it('defaults to inherit and disables new-branch adoption (inert)', () => {
    expect(resolveSdkHomeConfig({})).toEqual({ mode: 'inherit', enabledForNewBranches: false });
    expect(resolveSdkHomeConfig({ execution: {} })).toEqual({
      mode: 'inherit',
      enabledForNewBranches: false,
    });
    expect(resolveSdkHomeConfig({ execution: { sandbox: {} } }).mode).toBe('inherit');
  });

  it('enables new-branch adoption only under per_branch', () => {
    expect(
      resolveSdkHomeConfig({ execution: { sandbox: { sdk_home_mode: 'per_branch' } } })
    ).toEqual({ mode: 'per_branch', enabledForNewBranches: true });
    expect(
      resolveSdkHomeConfig({ execution: { sandbox: { sdk_home_mode: 'inherit' } } })
        .enabledForNewBranches
    ).toBe(false);
  });
});

describe('resolveBranchSdkHomeLaunch (design §8)', () => {
  const expectedRoot = join(DATA_HOME, 'branch-homes', BRANCH_ID);

  it('claude-code → CLAUDE_CONFIG_DIR at the claude subdir', () => {
    const launch = resolveBranchSdkHomeLaunch({ tool: 'claude-code', branchId: BRANCH_ID });
    expect(launch?.branchHomeDir).toBe(expectedRoot);
    expect(launch?.envVars).toEqual({ CLAUDE_CONFIG_DIR: join(expectedRoot, 'claude') });
    expect(launch?.ensureDirs).toContain(join(expectedRoot, 'claude'));
  });

  it('codex → CODEX_HOME + CODEX_SQLITE_HOME co-located in the codex subdir', () => {
    const launch = resolveBranchSdkHomeLaunch({ tool: 'codex', branchId: BRANCH_ID });
    expect(launch?.envVars).toEqual({
      CODEX_HOME: join(expectedRoot, 'codex'),
      CODEX_SQLITE_HOME: join(expectedRoot, 'codex'),
    });
  });

  it('gemini (home-root) → GEMINI_CLI_HOME at the gemini subdir (CLI appends .gemini)', () => {
    const launch = resolveBranchSdkHomeLaunch({ tool: 'gemini', branchId: BRANCH_ID });
    expect(launch?.envVars).toEqual({ GEMINI_CLI_HOME: join(expectedRoot, 'gemini') });
  });

  it('copilot → COPILOT_HOME and a DISTINCT COPILOT_CACHE_HOME', () => {
    const launch = resolveBranchSdkHomeLaunch({ tool: 'copilot', branchId: BRANCH_ID });
    expect(launch?.envVars.COPILOT_HOME).toBe(join(expectedRoot, 'copilot'));
    expect(launch?.envVars.COPILOT_CACHE_HOME).toBe(join(expectedRoot, 'copilot-cache'));
    expect(launch?.envVars.COPILOT_HOME).not.toBe(launch?.envVars.COPILOT_CACHE_HOME);
  });

  it('opencode is hook-managed → returns null (handled via getExecutorLaunch)', () => {
    expect(resolveBranchSdkHomeLaunch({ tool: 'opencode', branchId: BRANCH_ID })).toBeNull();
  });

  it('cursor has no relocation mechanism → throws (caller must refuse first)', () => {
    expect(() => resolveBranchSdkHomeLaunch({ tool: 'cursor', branchId: BRANCH_ID })).toThrow();
  });

  it('rejects an unsafe branchId (path traversal)', () => {
    expect(() => resolveBranchSdkHomeLaunch({ tool: 'codex', branchId: '../escape' })).toThrow();
  });
});

describe('resolveBranchSdkHomeTerminalEnv (design §12 Q7)', () => {
  it('aggregates every generic tool var but excludes OpenCode XDG globals', () => {
    const env = resolveBranchSdkHomeTerminalEnv({ branchId: BRANCH_ID }).envVars;
    expect(Object.keys(env).sort()).toEqual(
      [
        'CLAUDE_CONFIG_DIR',
        'CODEX_HOME',
        'CODEX_SQLITE_HOME',
        'COPILOT_CACHE_HOME',
        'COPILOT_HOME',
        'GEMINI_CLI_HOME',
      ].sort()
    );
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });
});
