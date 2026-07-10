import type { Link } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import type { LinkDisplayItem } from './linkDisplay';
import {
  findTeammateLinkForTarget,
  getTeammatePromotionState,
  promoteLinkToTeammate,
} from './linkPromotion';

function link(overrides: Partial<Link> = {}): Link {
  return {
    link_id: 'link-1' as Link['link_id'],
    branch_id: 'teammate-1' as Link['branch_id'],
    session_id: null,
    kind: 'url',
    source: 'manual',
    url: 'https://example.com',
    ref_uri: null,
    file_path: null,
    target_key: 'url:https://example.com/',
    is_pinned: true,
    title: null,
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function item(overrides: Partial<LinkDisplayItem> = {}): LinkDisplayItem {
  return {
    key: 'item-1',
    name: 'Example',
    targetKey: 'url:https://example.com/',
    category: 'url',
    ownerScope: 'session',
    isPinned: false,
    linkId: 'source-1',
    url: 'https://example.com',
    ...overrides,
  };
}

describe('linkPromotion', () => {
  it('finds teammate links by exact target key', () => {
    const teammateLink = link({ target_key: 'url:https://example.com/' });
    expect(findTeammateLinkForTarget(item(), [teammateLink])).toBe(teammateLink);
    expect(
      findTeammateLinkForTarget(item(), [link({ target_key: 'URL:https://example.com/' })])
    ).toBeNull();
  });

  it('does not collide file-backed target keys that differ only by path case', () => {
    const reportPdf = link({
      link_id: 'teammate-report-upper' as Link['link_id'],
      kind: 'document',
      source: 'upload',
      url: null,
      file_path: '/uploads/Report.pdf',
      target_key: 'file:/uploads/Report.pdf',
      title: 'Report.pdf',
    });
    const reportLowerPdf = link({
      link_id: 'teammate-report-lower' as Link['link_id'],
      kind: 'document',
      source: 'upload',
      url: null,
      file_path: '/uploads/report.pdf',
      target_key: 'file:/uploads/report.pdf',
      title: 'report.pdf',
    });

    expect(
      findTeammateLinkForTarget(
        item({
          targetKey: 'file:/uploads/Report.pdf',
          filePath: '/uploads/Report.pdf',
          url: undefined,
        }),
        [reportLowerPdf, reportPdf]
      )
    ).toBe(reportPdf);
    expect(
      findTeammateLinkForTarget(
        item({
          targetKey: 'file:/uploads/REPORT.pdf',
          filePath: '/uploads/REPORT.pdf',
          url: undefined,
        }),
        [reportLowerPdf, reportPdf]
      )
    ).toBeNull();
  });

  it('computes promotable and promoted states', () => {
    expect(
      getTeammatePromotionState({
        item: item(),
        teammateBranchId: 'teammate-1',
        sourceBranchId: 'branch-1',
        teammateLinks: [],
      })
    ).toMatchObject({ canPromote: true, isPromoted: false });

    expect(
      getTeammatePromotionState({
        item: item(),
        teammateBranchId: 'teammate-1',
        sourceBranchId: 'branch-1',
        teammateLinks: [link()],
      })
    ).toMatchObject({ canPromote: true, isPromoted: true, teammateLink: link() });
  });

  it('does not promote missing source links, missing teammates, or teammate-owned links', () => {
    expect(
      getTeammatePromotionState({
        item: item({ linkId: undefined }),
        teammateBranchId: 'teammate-1',
        sourceBranchId: 'branch-1',
        teammateLinks: [],
      })
    ).toMatchObject({ canPromote: false, reason: 'missing-source-link' });

    expect(
      getTeammatePromotionState({
        item: item(),
        teammateBranchId: null,
        sourceBranchId: 'branch-1',
        teammateLinks: [],
      })
    ).toMatchObject({ canPromote: false, reason: 'no-teammate' });

    expect(
      getTeammatePromotionState({
        item: item(),
        teammateBranchId: 'teammate-1',
        sourceBranchId: 'teammate-1',
        teammateLinks: [],
      })
    ).toMatchObject({ canPromote: false, reason: 'same-owner' });
  });

  it('keeps unresolved file and internal promotion unavailable', () => {
    expect(
      getTeammatePromotionState({
        item: item({
          kind: 'document',
          source: 'upload',
          filePath: '/uploads/report.pdf',
          url: undefined,
          targetKey: 'file:/uploads/report.pdf',
        }),
        teammateBranchId: 'teammate-1',
        sourceBranchId: 'branch-1',
        teammateLinks: [],
      })
    ).toMatchObject({ canPromote: false, reason: 'file-lifetime' });

    expect(
      getTeammatePromotionState({
        item: item({
          kind: 'internal',
          refUri: 'agor://branch/branch-2',
          url: undefined,
          targetKey: 'ref:agor://branch/branch-2',
        }),
        teammateBranchId: 'teammate-1',
        sourceBranchId: 'branch-1',
        teammateLinks: [],
      })
    ).toMatchObject({ canPromote: false, reason: 'internal-target-access' });
  });

  it('allows an existing legacy teammate copy to be removed', () => {
    const teammateFile = link({
      kind: 'document',
      source: 'upload',
      url: null,
      file_path: '/uploads/report.pdf',
      target_key: 'file:/uploads/report.pdf',
    });
    expect(
      getTeammatePromotionState({
        item: item({
          kind: 'document',
          source: 'upload',
          filePath: '/uploads/report.pdf',
          url: undefined,
          targetKey: 'file:/uploads/report.pdf',
        }),
        teammateBranchId: 'teammate-1',
        sourceBranchId: 'branch-1',
        teammateLinks: [teammateFile],
      })
    ).toMatchObject({ canPromote: true, isPromoted: true, teammateLink: teammateFile });
  });

  it('calls the promotion service path with only teammate target payload', async () => {
    const create = vi.fn(async () => link());
    const client = {
      service: vi.fn(() => ({ create })),
    };

    await promoteLinkToTeammate({
      client: client as never,
      sourceLinkId: 'source-1',
      teammateBranchId: 'teammate-1',
    });

    expect(client.service).toHaveBeenCalledWith('links/source-1/promote');
    expect(create).toHaveBeenCalledWith({
      target: 'teammate',
      teammate_branch_id: 'teammate-1',
    });
  });
});
