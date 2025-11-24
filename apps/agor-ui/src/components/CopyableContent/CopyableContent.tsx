/**
 * CopyableContent - Wrapper component that adds copy-to-clipboard functionality
 *
 * Displays a copy icon in the top-right corner on hover that copies the text content.
 * Extracted from MessageBlock for reuse across the codebase (MessageBlock, AgentChain, etc.)
 */

import { CopyOutlined } from '@ant-design/icons';
import { Tooltip, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { useCopyToClipboard } from '../../utils/clipboard';

export interface CopyableContentProps {
  /**
   * The text content to copy to clipboard
   */
  textContent: string;

  /**
   * The visual content to display (can be different from textContent)
   */
  children: React.ReactNode;

  /**
   * Optional positioning adjustment for the copy button
   */
  copyButtonOffset?: {
    top?: number;
    right?: number;
  };

  /**
   * Optional tooltip text (defaults to "Copy" / "Copied!")
   */
  copyTooltip?: string;
  copiedTooltip?: string;
}

export const CopyableContent: React.FC<CopyableContentProps> = ({
  textContent,
  children,
  copyButtonOffset = {},
  copyTooltip = 'Copy to clipboard',
  copiedTooltip = 'Copied!',
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [copied, copy] = useCopyToClipboard();
  const { token } = theme.useToken();

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copy(textContent);
  };

  const { top = -(token.sizeUnit * 2), right = -(token.sizeUnit * 2) } = copyButtonOffset;

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
      {isHovered && (
        <Tooltip title={copied ? copiedTooltip : copyTooltip}>
          <CopyOutlined
            onClick={handleCopy}
            style={{
              position: 'absolute',
              top,
              right,
              cursor: 'pointer',
              fontSize: token.fontSizeSM,
              color: copied ? token.colorSuccess : token.colorTextSecondary,
              padding: token.sizeXXS,
              transition: 'all 0.2s',
              zIndex: 1,
            }}
            onMouseEnter={(e) => {
              if (!copied) {
                e.currentTarget.style.color = token.colorPrimary;
              }
            }}
            onMouseLeave={(e) => {
              if (!copied) {
                e.currentTarget.style.color = token.colorTextSecondary;
              }
            }}
          />
        </Tooltip>
      )}
    </div>
  );
};
