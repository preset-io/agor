import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agenticToolUsesBranchSdkHome,
  branchSdkHomeAuthUnsupportedReason,
  branchSdkHomeUnsupportedReason,
  resolveBranchSdkHomeLaunch,
  resolveNewSessionSdkHomeScope,
  resolveSdkHomeConfig,
  sessionUsesBranchSdkHome,
} from './branch-sdk-home.js';

describe('built-in tools', () => {
  it('allow branch-scoped Sessions without manufacturing provider SDK state', () => {
    expect(branchSdkHomeUnsupportedReason('workload')).toBeUndefined();
    expect(agenticToolUsesBranchSdkHome('workload')).toBe(false);
  });
});

// getBranchHomePath derives from AGOR_DATA_HOME → make the root deterministic.
const DATA_HOME = mkdtempSync(join(tmpdir(), 'agor-sdk-home-test-'));
const priorDataHome = process.env.AGOR_DATA_HOME;
beforeAll(() => {
  process.env.AGOR_DATA_HOME = DATA_HOME;
});

describe('sessionUsesBranchSdkHome', () => {
  it('keeps a historical session in its execution home on an adopted branch', () => {
    expect(
      sessionUsesBranchSdkHome({
        sessionScope: 'execution_home',
        branchSdkHomeIntent: 'per_branch',
      })
    ).toBe(false);
  });

  it('mounts only for a branch-scoped session with matching branch intent', () => {
    expect(
      sessionUsesBranchSdkHome({ sessionScope: 'branch', branchSdkHomeIntent: 'per_branch' })
    ).toBe(true);
  });

  it('fails closed instead of falling back when the two durable stamps disagree', () => {
    expect(() =>
      sessionUsesBranchSdkHome({ sessionScope: 'branch', branchSdkHomeIntent: null })
    ).toThrow(/refusing fallback/);
  });
});

describe('resolveNewSessionSdkHomeScope', () => {
  it('backfills compatibility by keeping fresh sessions in the execution home by default', () => {
    expect(
      resolveNewSessionSdkHomeScope({
        branchSdkHomeIntent: null,
        enabledForNewSessions: false,
      })
    ).toEqual({ scope: 'execution_home', adoptBranch: false });
  });

  it('atomically adopts an unadopted branch for a fresh opted-in session', () => {
    expect(
      resolveNewSessionSdkHomeScope({
        branchSdkHomeIntent: null,
        enabledForNewSessions: true,
      })
    ).toEqual({ scope: 'branch', adoptBranch: true });
  });

  it('keeps new sessions branch-scoped after deployment opt-out once the branch adopted', () => {
    expect(
      resolveNewSessionSdkHomeScope({
        branchSdkHomeIntent: 'per_branch',
        enabledForNewSessions: false,
      })
    ).toEqual({ scope: 'branch', adoptBranch: false });
  });

  it("lets a child retain its parent's historical execution-home lineage", () => {
    expect(
      resolveNewSessionSdkHomeScope({
        branchSdkHomeIntent: 'per_branch',
        enabledForNewSessions: true,
        inheritedScope: 'execution_home',
      })
    ).toEqual({ scope: 'execution_home', adoptBranch: false });
  });
});
afterAll(() => {
  if (priorDataHome === undefined) delete process.env.AGOR_DATA_HOME;
  else process.env.AGOR_DATA_HOME = priorDataHome;
});

const BRANCH_ID = '0193b1c2-3d4e-7f00-9abc-def012345678';

describe('resolveSdkHomeConfig (design §9.1)', () => {
  it('defaults to inherit and disables new-branch adoption (inert)', () => {
    expect(resolveSdkHomeConfig({})).toEqual({ mode: 'inherit', enabledForNewSessions: false });
    expect(resolveSdkHomeConfig({ execution: {} })).toEqual({
      mode: 'inherit',
      enabledForNewSessions: false,
    });
    expect(resolveSdkHomeConfig({ execution: { sandbox: {} } }).mode).toBe('inherit');
  });

  it('enables new-branch adoption only under per_branch', () => {
    expect(
      resolveSdkHomeConfig({ execution: { sandbox: { sdk_home_mode: 'per_branch' } } })
    ).toEqual({ mode: 'per_branch', enabledForNewSessions: true });
    expect(
      resolveSdkHomeConfig({ execution: { sandbox: { sdk_home_mode: 'inherit' } } })
        .enabledForNewSessions
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

  it('refuses opencode because native credentials share its XDG data home', () => {
    expect(() => resolveBranchSdkHomeLaunch({ tool: 'opencode', branchId: BRANCH_ID })).toThrow(
      /credentials/
    );
  });

  it('cursor has no relocation mechanism → throws (caller must refuse first)', () => {
    expect(() => resolveBranchSdkHomeLaunch({ tool: 'cursor', branchId: BRANCH_ID })).toThrow();
  });

  it('rejects an unsafe branchId (path traversal)', () => {
    expect(() => resolveBranchSdkHomeLaunch({ tool: 'codex', branchId: '../escape' })).toThrow();
  });
});

describe('branchSdkHomeAuthUnsupportedReason', () => {
  const nativeAuth = { useNativeAuth: true };

  it('refuses local Codex subscription auth before branch adoption', () => {
    expect(
      branchSdkHomeAuthUnsupportedReason({
        tool: 'codex',
        delegated: false,
        secureLocalCredentialOverlay: false,
        auth: nativeAuth,
      })
    ).toMatch(/subscription auth/);
  });

  it('allows Codex API-key mode and delegates external credential policy', () => {
    expect(
      branchSdkHomeAuthUnsupportedReason({
        tool: 'codex',
        delegated: false,
        secureLocalCredentialOverlay: false,
        auth: { useNativeAuth: false, apiKey: 'configured' },
      })
    ).toBeUndefined();
    expect(
      branchSdkHomeAuthUnsupportedReason({
        tool: 'codex',
        delegated: true,
        secureLocalCredentialOverlay: false,
        auth: nativeAuth,
      })
    ).toBeUndefined();
  });

  it('allows local Codex subscription auth through the pinned sandbox overlay', () => {
    expect(
      branchSdkHomeAuthUnsupportedReason({
        tool: 'codex',
        delegated: false,
        secureLocalCredentialOverlay: true,
        auth: nativeAuth,
      })
    ).toBeUndefined();
  });
});
