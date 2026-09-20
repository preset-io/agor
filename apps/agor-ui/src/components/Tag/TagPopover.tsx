import type { PopoverProps } from 'antd';
import { Popover } from 'antd';
import type React from 'react';

/** `getPopupContainer` is owned here — see the note on {@link TagPopover}. */
export type TagPopoverProps = Omit<PopoverProps, 'getPopupContainer'>;

/**
 * Popover anchored to a chip/tag.
 *
 * Chips sit inside clipped chrome — the session footer, a scrolling task list,
 * a board card. Parenting the popup to the trigger clips it at the first
 * `overflow: hidden` ancestor, and AntD's collision logic measures that box
 * rather than the viewport, so the popup is cut off instead of moving. Renders
 * into the document body instead, which leaves the built-in
 * `autoAdjustOverflow` free to flip to the opposite side when the popup does
 * not fit on its preferred one.
 */
export const TagPopover: React.FC<TagPopoverProps> = ({ placement = 'top', ...props }) => (
  <Popover
    {...props}
    placement={placement}
    getPopupContainer={(trigger) => trigger.ownerDocument.body}
  />
);
