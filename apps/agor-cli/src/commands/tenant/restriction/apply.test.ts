import { InvalidTenantIdError } from '@agor/core/db';
import { TenantRestrictionConflictError } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  buildTenantRestrictionCommand,
  EXIT_CONFLICT,
  EXIT_FAILURE,
  EXIT_UNSUPPORTED,
  type TenantRestrictionApplyFlags,
  tenantRestrictionErrorLine,
  tenantRestrictionFailure,
} from '../../../lib/tenant-restriction.js';
import { runTenantRestrictionCli } from '../../../lib/tenant-restriction.test-support.js';

function flags(overrides: Partial<TenantRestrictionApplyFlags> = {}): TenantRestrictionApplyFlags {
  return {
    'tenant-id': 'acme-corp',
    'controller-id': 'agor-cloud-team-suspension-v1',
    'placement-id': 'cell-7',
    'operation-id': 'susp-42',
    revision: 3,
    action: 'restrict',
    ...overrides,
  };
}

describe('buildTenantRestrictionCommand', () => {
  it('builds the version-1 command from flags', () => {
    expect(buildTenantRestrictionCommand(flags())).toEqual({
      version: 1,
      controllerId: 'agor-cloud-team-suspension-v1',
      placementId: 'cell-7',
      operationId: 'susp-42',
      revision: 3,
      action: 'restrict',
    });
  });

  it('builds the re-home seed command the destination runtime accepts on empty history', () => {
    expect(buildTenantRestrictionCommand(flags({ action: 'seed_active' })).action).toBe(
      'seed_active'
    );
  });

  it.each<[string, Partial<TenantRestrictionApplyFlags>]>([
    ['an unknown action', { action: 'force_active' }],
    ['a zero revision', { revision: 0 }],
    ['a negative revision', { revision: -1 }],
    ['a fractional revision', { revision: 1.5 }],
    ['an empty controller id', { 'controller-id': '' }],
    ['a controller id with an illegal character', { 'controller-id': 'control/one' }],
    ['a placement id that does not start alphanumerically', { 'placement-id': '-cell' }],
    ['an operation id beyond the length bound', { 'operation-id': 'o'.repeat(201) }],
  ])('rejects %s before any database connection', (_label, overrides) => {
    expect(() => buildTenantRestrictionCommand(flags(overrides))).toThrow();
    expect(
      tenantRestrictionFailure(safeCatch(() => buildTenantRestrictionCommand(flags(overrides))))
    ).toEqual({ exitCode: EXIT_FAILURE, code: 'invalid_command' });
  });
});

describe('tenantRestrictionFailure', () => {
  it.each([
    'identity_mismatch',
    'stale_revision',
    'revision_conflict',
    'release_not_prepared',
  ] as const)('maps the %s conflict to exit 2 with its protocol code', (code) => {
    expect(tenantRestrictionFailure(new TenantRestrictionConflictError(code))).toEqual({
      exitCode: EXIT_CONFLICT,
      code,
    });
  });

  it('maps an unsupported (SQLite) runtime to exit 3', () => {
    expect(tenantRestrictionFailure(namedError('TenantRestrictionUnsupportedError'))).toEqual({
      exitCode: EXIT_UNSUPPORTED,
      code: 'unsupported_runtime',
    });
  });

  it('keeps a corrupt stored row a failure rather than an unrestricted answer', () => {
    expect(tenantRestrictionFailure(namedError('TenantRestrictionDataError'))).toEqual({
      exitCode: EXIT_FAILURE,
      code: 'invalid_restriction_state',
    });
  });

  it('maps an invalid tenant id to exit 1, not the conflict code', () => {
    expect(
      tenantRestrictionFailure(new InvalidTenantIdError('Tenant id must not be empty'))
    ).toEqual({ exitCode: EXIT_FAILURE, code: 'invalid_command' });
  });

  it.each([
    ['an unknown error', new Error('connection reset to secret-host:5432')],
    ['a thrown string', 'boom'],
    ['null', null],
  ])('collapses %s to exit 1 without repeating its text', (_label, error) => {
    const failure = tenantRestrictionFailure(error);
    expect(failure).toEqual({ exitCode: EXIT_FAILURE, code: 'failed' });
    expect(tenantRestrictionErrorLine(failure.code)).toBe('{"error":"failed"}');
  });

  it.each<[string, unknown]>([
    ['a stringifiable object', { toString: (): string => 'identity_mismatch' }],
    ['a code the protocol does not define', 'tenant_is_naughty'],
    ['no code at all', undefined],
  ])('never reports %s as a conflict code', (_label, code) => {
    expect(tenantRestrictionFailure({ name: 'TenantRestrictionConflictError', code })).toEqual({
      exitCode: EXIT_CONFLICT,
      code: 'failed',
    });
  });
});

describe('tenantRestrictionErrorLine', () => {
  it('writes one bounded JSON object', () => {
    expect(JSON.parse(tenantRestrictionErrorLine('stale_revision'))).toEqual({
      error: 'stale_revision',
    });
  });
});

function namedError(name: string): Error {
  const error = new Error('should never be printed');
  error.name = name;
  return error;
}

function safeCatch(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('agor tenant restriction apply (argument contract)', () => {
  it('rejects an action the protocol does not define without opening a database', async () => {
    const result = await runTenantRestrictionCli([
      'apply',
      '--tenant-id',
      'acme-corp',
      '--controller-id',
      'agor-cloud-team-suspension-v1',
      '--placement-id',
      'cell-7',
      '--operation-id',
      'susp-42',
      '--revision',
      '3',
      '--action',
      'force_active',
    ]);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('{"error":"invalid_command"}');
  }, 40_000);

  it('rejects a missing required flag with the same bounded failure line', async () => {
    const result = await runTenantRestrictionCli([
      'apply',
      '--tenant-id',
      'acme-corp',
      '--controller-id',
      'agor-cloud-team-suspension-v1',
      '--placement-id',
      'cell-7',
      '--action',
      'restrict',
    ]);

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('{"error":"invalid_command"}');
  }, 40_000);
});
