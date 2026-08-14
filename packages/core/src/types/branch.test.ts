import { describe, expect, it } from 'vitest';
import {
  isBranchArchiveOrDeleteOptions,
  isBranchUnarchiveOptions,
  isValidManagedBranchName,
} from './branch';

describe('isValidManagedBranchName', () => {
  it.each(['issue-2295-viewer-role-auth', 'main', 'a', '123'])('accepts %s', (value) => {
    expect(isValidManagedBranchName(value)).toBe(true);
  });

  it.each(['..', '../victim', 'feature/nested', '/absolute', 'has space', '', null])(
    'rejects unsafe path identity %#',
    (value) => {
      expect(isValidManagedBranchName(value)).toBe(false);
    }
  );
});

describe('isBranchArchiveOrDeleteOptions', () => {
  it.each([
    { metadataAction: 'archive', filesystemAction: 'preserved' },
    { metadataAction: 'archive', filesystemAction: 'cleaned' },
    { metadataAction: 'archive', filesystemAction: 'deleted' },
    { metadataAction: 'delete', filesystemAction: 'preserved' },
    { metadataAction: 'delete', filesystemAction: 'deleted' },
  ])('accepts the supported combination %#', (value) => {
    expect(isBranchArchiveOrDeleteOptions(value)).toBe(true);
  });

  it.each([
    null,
    {},
    { metadataAction: 'remove', filesystemAction: 'deleted' },
    { metadataAction: 'delete', filesystemAction: 'cleaned' },
    { metadataAction: 'archive', filesystemAction: 'missing' },
    { metadataAction: 'delete', filesystemAction: 'deleted', extra: true },
  ])('rejects invalid or ambiguous input %#', (value) => {
    expect(isBranchArchiveOrDeleteOptions(value)).toBe(false);
  });
});

describe('isBranchUnarchiveOptions', () => {
  it.each([{}, { boardId: '01900000-0000-7000-8000-000000000001' }])(
    'accepts the supported combination %#',
    (value) => {
      expect(isBranchUnarchiveOptions(value)).toBe(true);
    }
  );

  it.each([undefined, null, [], 'board', { boardId: '' }, { boardId: null }, { extra: true }])(
    'rejects invalid or ambiguous input %#',
    (value) => {
      expect(isBranchUnarchiveOptions(value)).toBe(false);
    }
  );
});
