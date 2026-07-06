import type { Link } from '@agor-live/client';
import { normalizeUrlTargetKey } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getAssistantPromotionState } from './linkPromotion';

const now = '2026-07-06T00:00:00.000Z';

function makeLink(patch: Partial<Link>): Link {
  const url = patch.url ?? 'https://example.com/docs';
  return {
    link_id: 'assistant-link' as Link['link_id'],
    branch_id: 'assistant-branch' as Link['branch_id'],
    session_id: null,
    source_message_id: null,
    kind: 'url',
    source: 'manual',
    url,
    ref_uri: null,
    file_path: null,
    target_key: normalizeUrlTargetKey(url),
    is_pinned: true,
    title: null,
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...patch,
  } as Link;
}

describe('assistant link promotion state', () => {
  it('offers promotion when a saved source link is not on the assistant', () => {
    const state = getAssistantPromotionState({
      item: { linkId: 'source-link', targetKey: normalizeUrlTargetKey('https://example.com/a') },
      assistantBranchId: 'assistant-branch',
      assistantLinks: [],
      sourceBranchId: 'branch-1',
    });

    expect(state).toMatchObject({
      isPromoted: false,
      canUseAssistantPromotion: true,
      actionLabel: 'Promote to assistant',
    });
  });

  it('offers removal when an assistant copy already has the same target key', () => {
    const assistantLink = makeLink({ url: 'https://example.com/docs' });
    const state = getAssistantPromotionState({
      item: {
        linkId: 'source-link',
        targetKey: normalizeUrlTargetKey('https://example.com/docs#ignored'),
      },
      assistantBranchId: 'assistant-branch',
      assistantLinks: [assistantLink],
      sourceBranchId: 'branch-1',
    });

    expect(state).toMatchObject({
      assistantLink,
      isPromoted: true,
      canUseAssistantPromotion: true,
      actionLabel: 'Remove from assistant',
    });
  });

  it('treats rows owned by the primary assistant branch as assistant-owned', () => {
    const state = getAssistantPromotionState({
      item: { linkId: 'assistant-link', targetKey: normalizeUrlTargetKey('https://example.com/a') },
      assistantBranchId: 'assistant-branch',
      assistantLinks: [],
      sourceBranchId: 'assistant-branch',
    });

    expect(state).toMatchObject({
      isAssistantOwned: true,
      isPromoted: true,
      actionLabel: 'Remove from assistant',
    });
  });

  it('explains unavailable states for missing assistant or unsaved synthetic rows', () => {
    expect(
      getAssistantPromotionState({
        item: { linkId: 'source-link', targetKey: 'url:https://example.com/a' },
        assistantBranchId: null,
        assistantLinks: [],
        sourceBranchId: 'branch-1',
      })
    ).toMatchObject({
      canUseAssistantPromotion: false,
      unavailableReason: 'No primary assistant is assigned to this board.',
    });

    expect(
      getAssistantPromotionState({
        item: { targetKey: 'url:https://example.com/a' },
        assistantBranchId: 'assistant-branch',
        assistantLinks: [],
        sourceBranchId: 'branch-1',
      })
    ).toMatchObject({
      canUseAssistantPromotion: false,
      unavailableReason: 'Only saved links can be promoted to the assistant.',
    });
  });
});
