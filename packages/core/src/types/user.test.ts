/**
 * User type utilities tests
 *
 * Tests normalizeRole backwards compatibility for deprecated 'owner' → 'superadmin'.
 */

import { describe, expect, it } from 'vitest';
import { normalizeRole } from './user';

describe('normalizeRole', () => {
  it('converts owner to superadmin', () => {
    expect(normalizeRole('owner')).toBe('superadmin');
  });

  it('passes through superadmin unchanged', () => {
    expect(normalizeRole('superadmin')).toBe('superadmin');
  });

  it('passes through admin unchanged', () => {
    expect(normalizeRole('admin')).toBe('admin');
  });

  it('passes through member unchanged', () => {
    expect(normalizeRole('member')).toBe('member');
  });

  it('passes through viewer unchanged', () => {
    expect(normalizeRole('viewer')).toBe('viewer');
  });

  it('defaults undefined to member', () => {
    expect(normalizeRole(undefined)).toBe('member');
  });
});
