import type { TagProps as AntTagProps } from 'antd';
import { Tag as AntTag } from 'antd';
import { type AnchorHTMLAttributes, type CSSProperties, forwardRef } from 'react';

export interface TagProps extends AntTagProps {
  /** Forwarded when Ant Design renders the Tag as an anchor via `href`. */
  rel?: AnchorHTMLAttributes<HTMLAnchorElement>['rel'];
  /**
   * Grow up to the available width, then ellipsize inside the border instead of
   * painting past it. Needs an ancestor with a definite width — a percentage
   * max-width is inert under a shrink-to-fit parent (table cell, `inline-block`
   * wrapper), so pass a numeric `style.maxWidth` there too.
   */
  truncate?: boolean;
}

/** `minWidth` (not `overflow: hidden`) lets the tag shrink, so the click ripple stays unclipped. */
const TRUNCATE_STYLE: CSSProperties = {
  maxWidth: '100%',
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
};

/** The label is a flex item, so `minWidth` is what defeats its min-content floor. */
const TRUNCATE_LABEL_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/** Merge per key: styling one part must not silently drop the truncation. */
function withTruncateStyles(styles: AntTagProps['styles']): AntTagProps['styles'] {
  if (typeof styles === 'function') {
    return (info: Parameters<typeof styles>[0]) => {
      const resolved = styles(info);
      return { ...resolved, content: { ...TRUNCATE_LABEL_STYLE, ...resolved?.content } };
    };
  }
  return { ...styles, content: { ...TRUNCATE_LABEL_STYLE, ...styles?.content } };
}

/**
 * Base Tag component - wraps antd Tag with outlined variant as default
 *
 * Use this instead of importing Tag directly from 'antd' to ensure
 * consistent outlined styling across the application.
 */
const TagComponent = forwardRef<HTMLSpanElement | HTMLAnchorElement, TagProps>(
  ({ variant = 'outlined', truncate = false, icon, style, styles, children, ...props }, ref) => {
    return (
      <AntTag
        ref={ref}
        variant={variant}
        icon={icon}
        style={truncate ? { ...TRUNCATE_STYLE, ...style } : style}
        styles={truncate ? withTruncateStyles(styles) : styles}
        {...props}
      >
        {/* antd only moves children into a styleable span when an icon is set. */}
        {truncate && !icon && children != null ? (
          <span style={TRUNCATE_LABEL_STYLE}>{children}</span>
        ) : (
          children
        )}
      </AntTag>
    );
  }
);

TagComponent.displayName = 'Tag';

// Re-export CheckableTag unchanged (it's a property on Tag, not a direct export)
export const CheckableTag = AntTag.CheckableTag;

// Assign static properties for API compatibility (Tag.CheckableTag)
export const Tag = Object.assign(TagComponent, {
  CheckableTag: AntTag.CheckableTag,
});
