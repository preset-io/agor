import type { TagProps as AntTagProps } from 'antd';
import { Tag as AntTag } from 'antd';
import { forwardRef } from 'react';

export interface TagProps extends AntTagProps {
  // All antd Tag props are inherited
}

/**
 * Base Tag component - wraps antd Tag with outlined variant as default
 *
 * Use this instead of importing Tag directly from 'antd' to ensure
 * consistent outlined styling across the application.
 */
const TagComponent = forwardRef<HTMLSpanElement, TagProps>(
  ({ variant = 'outlined', ...props }, ref) => {
    return <AntTag ref={ref} variant={variant} {...props} />;
  }
);

TagComponent.displayName = 'Tag';

// Re-export CheckableTag unchanged (it's a property on Tag, not a direct export)
export const CheckableTag = AntTag.CheckableTag;

// Assign static properties for API compatibility (Tag.CheckableTag)
export const Tag = Object.assign(TagComponent, {
  CheckableTag: AntTag.CheckableTag,
});
