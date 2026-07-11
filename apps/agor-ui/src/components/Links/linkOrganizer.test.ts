import { describe, expect, it } from 'vitest';
import type { LinkDisplayItem } from './linkDisplay';
import { selectQuickLinkDisplayItems } from './linkOrganizer';

function item(key: string, options: { pinned?: boolean; file?: boolean } = {}): LinkDisplayItem {
  return {
    key,
    name: key,
    targetKey: key,
    category: options.file ? 'document' : 'url',
    ownerScope: 'session',
    isPinned: options.pinned ?? false,
    ...(options.file ? { filePath: `${key}.txt` } : { url: `https://example.com/${key}` }),
  };
}

describe('selectQuickLinkDisplayItems', () => {
  it('counts pinned files toward the file reserve before filling remaining slots', () => {
    const items = [
      item('pinned-file-1', { pinned: true, file: true }),
      item('pinned-file-2', { pinned: true, file: true }),
      ...Array.from({ length: 5 }, (_, index) => item(`recent-${index + 1}`)),
    ];

    expect(selectQuickLinkDisplayItems(items).map(({ key }) => key)).toEqual(
      items.map(({ key }) => key)
    );
  });
});
