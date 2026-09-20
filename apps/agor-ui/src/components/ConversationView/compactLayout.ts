/**
 * Compact transcript grid.
 *
 * Every compact block — message bubble, thinking row, tool call, subagent
 * chain — is one `[gutter][content]` row. Avatars and activity icons are
 * centered in the same gutter column, and every label, body and output starts
 * at the same content edge. One declaration keeps those edges from drifting
 * apart as blocks are added.
 */

/** Width of the icon/avatar column. Also the compact avatar size. */
export const COMPACT_GUTTER_SIZE = 32;

/** Space between the gutter and the content column. */
export const COMPACT_GUTTER_GAP = 8;

/** Left edge every compact block's content aligns to. */
export const COMPACT_CONTENT_OFFSET = COMPACT_GUTTER_SIZE + COMPACT_GUTTER_GAP;

/** Multiplier on the theme's `sizeUnit` for the space between compact blocks. */
export const COMPACT_BLOCK_GAP_UNITS = 2;

/**
 * Inset for rows nested under a compact row (a subagent chain's steps under its
 * summary), applied either side of the guide line that groups them. Deliberately
 * slight: nested rows keep their own gutter, so the inset compounds with it and
 * still has to leave room for content at phone widths.
 */
export const COMPACT_NESTED_INDENT = 12;
