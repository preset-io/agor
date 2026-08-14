import { describe, expect, it } from 'vitest';
import { isBranchArchiveOrDeleteOptions } from './branch';

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
