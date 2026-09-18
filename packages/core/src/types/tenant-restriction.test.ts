import { describe, expect, it } from 'vitest';
import {
  isTenantRestrictionClosed,
  type TenantRestrictionCommand,
  TenantRestrictionCommandSchema,
  transitionTenantRestriction,
} from './tenant-restriction';

const restrict: TenantRestrictionCommand = {
  version: 1,
  controllerId: 'control-one',
  placementId: 'placement-one',
  operationId: 'suspend-one',
  revision: 1,
  action: 'restrict',
};
const release: TenantRestrictionCommand = {
  ...restrict,
  operationId: 'release-two',
  revision: 2,
  action: 'prepare_release',
};
const apply = transitionTenantRestriction;

describe('tenant restriction intent protocol', () => {
  it('requires a closed prepare before activation and retains the release watermark', () => {
    const first = apply(null, restrict);
    expect(first.changed).toBe(true);
    expect(isTenantRestrictionClosed(first.record)).toBe(true);
    expect(apply(first.record, restrict)).toEqual({ record: first.record, changed: false });
    const prepared = apply(first.record, release);
    expect(isTenantRestrictionClosed(prepared.record)).toBe(true);
    const activated = apply(prepared.record, { ...release, action: 'activate' });
    expect(isTenantRestrictionClosed(activated.record)).toBe(false);
    expect(apply(activated.record, release)).toEqual({ record: activated.record, changed: false });
    expect(apply(activated.record, { ...release, action: 'activate' }).changed).toBe(false);
    expect(() => apply(activated.record, restrict)).toThrow('stale_revision');
    expect(
      apply(activated.record, { ...restrict, revision: 3, operationId: 'suspend-three' }).record
        .phase
    ).toBe('restricted');
  });

  it('refuses activation without the exact prepared operation', () => {
    const current = apply(null, restrict).record;
    expect(() => apply(null, release)).toThrow('release_not_prepared');
    expect(() => apply(null, { ...restrict, action: 'activate' })).toThrow('release_not_prepared');
    expect(() => apply(current, { ...restrict, action: 'activate' })).toThrow('revision_conflict');
    expect(() => apply(current, { ...release, action: 'activate' })).toThrow(
      'release_not_prepared'
    );
    expect(() => apply(current, { ...restrict, operationId: 'another' })).toThrow(
      'revision_conflict'
    );
    expect(() => apply(current, { ...restrict, placementId: 'another' })).toThrow(
      'identity_mismatch'
    );
    expect(() => apply(current, { ...restrict, controllerId: 'another' })).toThrow(
      'identity_mismatch'
    );
    const prepared = apply(current, release).record;
    expect(() =>
      apply(prepared, { ...release, action: 'activate', operationId: 'another' })
    ).toThrow('revision_conflict');
    expect(() => apply(prepared, { ...release, action: 'restrict' })).toThrow('revision_conflict');
  });

  it('seeds an active watermark only on an empty history (re-home destination, plan D2)', () => {
    const seed: TenantRestrictionCommand = { ...restrict, revision: 4, action: 'seed_active' };
    const seeded = apply(null, seed);
    expect(seeded).toEqual({
      record: {
        version: 1,
        controllerId: 'control-one',
        placementId: 'placement-one',
        operationId: 'suspend-one',
        revision: 4,
        phase: 'active',
      },
      changed: true,
    });
    expect(isTenantRestrictionClosed(seeded.record)).toBe(false);
    // ANY recorded state refuses the seed — including an exact replay of the seed
    // this runtime already accepted, a closed row, and a foreign controller's row.
    for (const current of [
      seeded.record,
      apply(null, restrict).record,
      apply(apply(null, restrict).record, release).record,
      { ...seeded.record, controllerId: 'control-two' },
      { ...seeded.record, revision: 9 },
    ])
      expect(() => apply(current, seed)).toThrow('revision_conflict');
    // The seeded watermark still behaves like any other active record afterwards.
    expect(() => apply(seeded.record, { ...restrict, revision: 3 })).toThrow('stale_revision');
    expect(
      apply(seeded.record, { ...restrict, revision: 5, operationId: 'susp-5' }).record.phase
    ).toBe('restricted');
  });

  it('allows a newer restriction to supersede a pending release, never the inverse replay', () => {
    const prepared = apply(apply(null, restrict).record, release).record;
    const newer = apply(prepared, { ...restrict, revision: 3, operationId: 'three' }).record;
    expect(() => apply(newer, { ...release, action: 'activate' })).toThrow('stale_revision');
    expect(isTenantRestrictionClosed(newer)).toBe(true);
  });

  it('rejects ambiguous revisions, identities, protocol versions and unknown fields', () => {
    for (const patch of [
      { revision: 0 },
      { revision: -1 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { revision: '2' },
      { revision: Infinity },
      { version: 2 },
      { controllerId: '' },
      { placementId: 'a/b' },
      { operationId: 'a\n' },
      { force: true },
      { action: 'force_active' },
    ])
      expect(TenantRestrictionCommandSchema.safeParse({ ...restrict, ...patch }).success).toBe(
        false
      );
    expect(() =>
      isTenantRestrictionClosed({ ...apply(null, restrict).record, phase: 'bad' } as never)
    ).toThrow();
  });
});
