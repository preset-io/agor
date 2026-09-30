import type { GlobalToken } from 'antd';

/** Home's fixed layout measures, in px; spacing between them comes from theme tokens. */

/** Lead column of every Home row and group header: status dot, agent logo, avatar, board tile. */
export const HOME_ROW_LEAD = 20;
/** One line of row text at the base font size; row leads and trailing columns match it. */
export const HOME_ROW_LINE = 22;

/** Grouped My work: a branch line starts under its board's name (tile plus gap). */
export const homeGroupIndent = (token: GlobalToken) => HOME_ROW_LEAD + token.marginXS;
/** Grouped My work: sessions under a branch line sit one row gap further in. */
export const homeNestedIndent = (token: GlobalToken) => homeGroupIndent(token) + token.marginSM;

/** Page frame: content width cap, and room below the last section on wide screens. */
export const HOME_MAX_WIDTH = 1320;
export const HOME_BOTTOM_PADDING = 80;

/** The ask box's teammate picker never crowds out the send buttons. */
export const HOME_ASK_TARGET_MAX_WIDTH = 200;
/** Recent board pills, and branch/board pills in row meta on phones. */
export const HOME_BOARD_PILL_MAX_WIDTH = { compact: 110, wide: 190 } as const;
export const HOME_META_PILL_MAX_WIDTH_COMPACT = 140;
