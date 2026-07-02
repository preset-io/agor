// Pure width math for the resizable App layout panels. Extracted so it's
// unit-testable without mounting the full App component tree.

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Width of the middle "content" panel (canvas + session panel) as a
// percentage of the full viewport — whatever's left once the left
// assistant/comments panel (rail or fully expanded) takes its share.
export const getContentPanelWidthPercent = (
  leftPanelCollapsed: boolean,
  leftPanelCollapsedSize: number,
  leftPanelExpandedSize: number
) => 100 - (leftPanelCollapsed ? leftPanelCollapsedSize : leftPanelExpandedSize);

// The session/chat panel's persisted size is expressed as a percentage of
// the full viewport (so its absolute pixel width doesn't change when the
// left panel toggles between rail and expanded), but react-resizable-panels
// needs sizes expressed relative to each panel's own immediate parent — the
// content panel. These two functions convert between the two frames. Both
// clamp to [0, 100] and guard the divide so a momentarily-zero content width
// doesn't produce NaN/Infinity.
export const toContentRelativePercent = (
  viewportRelativePercent: number,
  contentPanelWidthPercent: number
) =>
  contentPanelWidthPercent > 0
    ? clamp((viewportRelativePercent / contentPanelWidthPercent) * 100, 0, 100)
    : 0;

export const toViewportRelativePercent = (
  contentRelativePercent: number,
  contentPanelWidthPercent: number
) => clamp((contentRelativePercent * contentPanelWidthPercent) / 100, 0, 100);
