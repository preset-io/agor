import type { TagProps as AntTagProps } from 'antd';
import { Tag as AntTag } from 'antd';
import type React from 'react';

export interface TagProps extends AntTagProps {
  // All antd Tag props are inherited
}

/**
 * Base Tag component - wraps antd Tag with outlined variant as default
 *
 * Use this instead of importing Tag directly from 'antd' to ensure
 * consistent outlined styling across the application.
 */
export const Tag: React.FC<TagProps> = ({ variant = 'outlined', ...props }) => {
  return <AntTag variant={variant} {...props} />;
};

// Re-export CheckableTag unchanged (it's a property on Tag, not a direct export)
export const CheckableTag = AntTag.CheckableTag;
