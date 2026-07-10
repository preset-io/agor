import { describe, expect, it } from 'vitest';
import type { LinkDisplayItem } from '../Links';
import {
  displayItemToSessionAttachmentItem,
  matchesSessionAttachmentCategory,
} from './sessionAttachmentModel';

describe('session attachment model', () => {
  it('uses the canonical organizer category rules for internal links', () => {
    const displayItem: LinkDisplayItem = {
      key: 'link:internal',
      name: 'Internal branch',
      targetKey: 'ref:agor://branch/123',
      category: 'internal',
      kind: 'internal',
      source: 'manual',
      ownerScope: 'session',
      isPinned: false,
      refUri: 'agor://branch/123',
      linkId: 'internal-link',
    };
    const attachment = displayItemToSessionAttachmentItem(displayItem);

    expect(matchesSessionAttachmentCategory(attachment, 'links')).toBe(true);
    expect(matchesSessionAttachmentCategory(attachment, 'knowledge')).toBe(false);
  });
});
