/**
 * Base Repository Tests
 *
 * Tests for base repository error classes and their message formatting.
 *
 * Note: BaseRepository is an interface with no implementation to test.
 * This file focuses on testing the error classes which have behavior.
 */

import { describe, expect, it } from 'vitest';
import {
  AmbiguousIdError,
  attachHiddenTenant,
  EntityNotFoundError,
  getHiddenTenantId,
  RepositoryError,
} from './base';

// ============================================================================
// RepositoryError
// ============================================================================

describe('RepositoryError', () => {
  it('should create error with message', () => {
    const error = new RepositoryError('Test error message');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RepositoryError);
    expect(error.message).toBe('Test error message');
    expect(error.name).toBe('RepositoryError');
  });

  it('should capture cause', () => {
    const cause = new Error('Original error');
    const error = new RepositoryError('Wrapped error', cause);

    expect(error.cause).toBe(cause);
  });

  it('should have undefined cause by default', () => {
    const error = new RepositoryError('Test error');

    expect(error.cause).toBeUndefined();
  });
});

// ============================================================================
// EntityNotFoundError
// ============================================================================

describe('EntityNotFoundError', () => {
  it('should format message with entity type and ID', () => {
    const error = new EntityNotFoundError('Session', 'abc123');

    expect(error).toBeInstanceOf(RepositoryError);
    expect(error).toBeInstanceOf(EntityNotFoundError);
    expect(error.message).toBe("Session with ID 'abc123' not found");
    expect(error.name).toBe('EntityNotFoundError');
    expect(error.entityType).toBe('Session');
    expect(error.id).toBe('abc123');
  });

  it('should handle different entity types', () => {
    const taskError = new EntityNotFoundError('Task', '12345');
    const branchError = new EntityNotFoundError('Branch', '67890');

    expect(taskError.message).toBe("Task with ID '12345' not found");
    expect(branchError.message).toBe("Branch with ID '67890' not found");
  });

  it('should preserve entity metadata', () => {
    const error = new EntityNotFoundError('Repo', 'test-id-123');

    expect(error.entityType).toBe('Repo');
    expect(error.id).toBe('test-id-123');
  });
});

// ============================================================================
// AmbiguousIdError
// ============================================================================

describe('AmbiguousIdError', () => {
  it('should format message with prefix and match count', () => {
    const matches = ['01933e4a-aaaa-1111', '01933e4a-bbbb-2222'];
    const error = new AmbiguousIdError('Session', '01933e4a', matches);

    expect(error).toBeInstanceOf(RepositoryError);
    expect(error).toBeInstanceOf(AmbiguousIdError);
    expect(error.message).toContain("Ambiguous ID prefix '01933e4a' for Session");
    expect(error.message).toContain('(2 matches');
    expect(error.message).toContain('01933e4a-aaaa-1111');
    expect(error.message).toContain('01933e4a-bbbb-2222');
    expect(error.name).toBe('AmbiguousIdError');
  });

  it('should truncate matches list with ellipsis for >3 matches', () => {
    const matches = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'];
    const error = new AmbiguousIdError('Task', 'prefix', matches);

    expect(error.message).toContain('(5 matches');
    expect(error.message).toContain('id-1, id-2, id-3...');
    expect(error.message).not.toContain('id-4');
    expect(error.message).not.toContain('id-5');
  });

  it('should show all matches when <=3', () => {
    const matches = ['id-1', 'id-2', 'id-3'];
    const error = new AmbiguousIdError('Branch', 'pre', matches);

    expect(error.message).toContain('(3 matches');
    expect(error.message).toContain('id-1, id-2, id-3');
    expect(error.message).not.toContain('...');
  });

  it('should preserve metadata fields', () => {
    const matches = ['match-1', 'match-2'];
    const error = new AmbiguousIdError('Repo', 'test-prefix', matches);

    expect(error.entityType).toBe('Repo');
    expect(error.prefix).toBe('test-prefix');
    expect(error.matches).toEqual(['match-1', 'match-2']);
  });

  it('should handle single match (edge case)', () => {
    const matches = ['single-id'];
    const error = new AmbiguousIdError('Session', 'abc', matches);

    expect(error.message).toContain('(1 matches');
    expect(error.message).toContain('single-id');
    expect(error.message).not.toContain('...');
  });

  it('should handle empty prefix', () => {
    const matches = ['id-1', 'id-2'];
    const error = new AmbiguousIdError('Task', '', matches);

    expect(error.message).toContain("Ambiguous ID prefix '' for Task");
    expect(error.prefix).toBe('');
  });
});

// ============================================================================
// Hidden tenant metadata
// ============================================================================

describe('hidden tenant metadata helpers', () => {
  it('attaches tenant_id as non-enumerable metadata and reads it back', () => {
    const dto = attachHiddenTenant({ id: 'schedule-1' }, { tenant_id: 'tenant-a' });

    expect(getHiddenTenantId(dto)).toBe('tenant-a');
    expect(Object.keys(dto)).toEqual(['id']);
    expect(JSON.stringify(dto)).toBe('{"id":"schedule-1"}');
  });

  it('ignores missing or empty tenant ids', () => {
    const dto = attachHiddenTenant({ id: 'schedule-1' }, { tenant_id: '' });

    expect(getHiddenTenantId(dto)).toBeUndefined();
    expect(Object.keys(dto)).toEqual(['id']);
  });
});
