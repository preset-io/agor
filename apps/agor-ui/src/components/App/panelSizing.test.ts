import { describe, expect, it } from 'vitest';
import {
  capSessionSizeForCanvasMin,
  getContentPanelWidthPercent,
  toContentRelativePercent,
  toViewportRelativePercent,
} from './panelSizing';

describe('getContentPanelWidthPercent', () => {
  it('subtracts the rail width from the viewport when collapsed', () => {
    expect(getContentPanelWidthPercent(true, 4, 24)).toBe(96);
  });

  it('subtracts the expanded left panel width when open', () => {
    expect(getContentPanelWidthPercent(false, 4, 24)).toBe(76);
  });
});

describe('viewport <-> content relative percent conversion', () => {
  it('converts a viewport-relative size into a larger content-relative size when the content panel is narrower than the viewport', () => {
    // Session panel wants 30% of the viewport; content panel is only 76%
    // of the viewport (left panel expanded to 24%) — so within its own
    // parent, the session panel must claim a bigger share.
    expect(toContentRelativePercent(30, 76)).toBeCloseTo(39.4736, 3);
  });

  it('round-trips back to the original viewport-relative percent', () => {
    const contentPanelWidthPercent = 76;
    const viewportRelativePercent = 30;
    const contentRelativePercent = toContentRelativePercent(
      viewportRelativePercent,
      contentPanelWidthPercent
    );
    expect(toViewportRelativePercent(contentRelativePercent, contentPanelWidthPercent)).toBeCloseTo(
      viewportRelativePercent,
      5
    );
  });

  it('keeps the absolute (viewport-relative) session panel size constant when the left panel collapses to a rail', () => {
    // Left panel expanded (24% of viewport) vs collapsed to a 4%-wide rail.
    // A session panel pinned at 30% of the viewport should convert to two
    // different content-relative percentages that both resolve back to the
    // same 30% of the viewport — i.e. the same absolute pixel width.
    const viewportRelativePercent = 30;
    const expandedContentWidth = getContentPanelWidthPercent(false, 4, 24);
    const collapsedContentWidth = getContentPanelWidthPercent(true, 4, 24);

    const expandedContentRelative = toContentRelativePercent(
      viewportRelativePercent,
      expandedContentWidth
    );
    const collapsedContentRelative = toContentRelativePercent(
      viewportRelativePercent,
      collapsedContentWidth
    );

    expect(toViewportRelativePercent(expandedContentRelative, expandedContentWidth)).toBeCloseTo(
      viewportRelativePercent,
      5
    );
    expect(toViewportRelativePercent(collapsedContentRelative, collapsedContentWidth)).toBeCloseTo(
      viewportRelativePercent,
      5
    );
  });

  it('returns 0 instead of NaN/Infinity when the content panel has no width', () => {
    expect(toContentRelativePercent(30, 0)).toBe(0);
  });

  it('clamps content-relative percent to [0, 100]', () => {
    expect(toContentRelativePercent(90, 10)).toBe(100);
  });

  it('clamps viewport-relative percent to [0, 100]', () => {
    expect(toViewportRelativePercent(150, 90)).toBe(100);
  });
});

describe('capSessionSizeForCanvasMin', () => {
  it('caps the session panel so the canvas panel keeps its minSize when the left panel is expanded', () => {
    // Chat pinned at 75% of the viewport (its max); left panel expanded to
    // 24%, leaving a 76%-wide content panel — converting to content-relative
    // asks for ~98.7%, which would starve the canvas below its 20% minimum.
    const contentPanelWidthPercent = getContentPanelWidthPercent(false, 4, 24);
    const sessionContentRelativePercent = toContentRelativePercent(75, contentPanelWidthPercent);

    expect(capSessionSizeForCanvasMin(sessionContentRelativePercent, 20)).toBeLessThanOrEqual(80);
  });

  it('passes the size through unchanged when it already leaves the canvas its minimum', () => {
    expect(capSessionSizeForCanvasMin(50, 20)).toBe(50);
  });
});
