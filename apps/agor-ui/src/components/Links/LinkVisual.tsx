import {
  BookOutlined,
  CodeOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Flex, theme } from 'antd';
import type React from 'react';
import {
  getLinkDisplayGlyphLabel,
  type LinkDisplayCategory,
  type LinkDisplayItem,
} from './linkDisplay';

export function getLinkCategoryIcon(
  category: LinkDisplayCategory,
  disabled = false
): React.ReactNode {
  if (disabled) return <StopOutlined />;
  switch (category) {
    case 'knowledge':
      return <BookOutlined />;
    case 'image':
      return <FileImageOutlined />;
    case 'pdf':
      return <FilePdfOutlined />;
    case 'spreadsheet':
    case 'csv':
      return <FileExcelOutlined />;
    case 'json':
    case 'code':
      return <CodeOutlined />;
    case 'document':
    case 'markdown':
    case 'text':
    case 'log':
      return <FileTextOutlined />;
    case 'issue':
    case 'pr':
      return <GithubOutlined />;
    case 'url':
      return <GlobalOutlined />;
    default:
      return category === 'unknown' ? <FileOutlined /> : <LinkOutlined />;
  }
}

function getLinkCompactGlyph(category: LinkDisplayCategory, disabled = false): React.ReactNode {
  if (disabled || category === 'issue' || category === 'pr') {
    return getLinkCategoryIcon(category, disabled);
  }
  return getLinkDisplayGlyphLabel(category);
}

export function getLinkItemIcon(
  item: Pick<LinkDisplayItem, 'category' | 'url' | 'refUri' | 'filePath'>,
  disabled = false
): React.ReactNode {
  if (disabled) return <StopOutlined />;
  if (item.category === 'url' && item.url) {
    try {
      const { hostname } = new URL(item.url);
      if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
        return <GithubOutlined />;
      }
    } catch {
      // The canonical target resolver owns URL validity.
    }
  }
  if (item.filePath && ['unknown', 'internal'].includes(item.category)) {
    return <FileTextOutlined />;
  }
  return getLinkCategoryIcon(item.category);
}

export function LinkRowGlyph({
  category,
  disabled = false,
  compact = false,
}: {
  category: LinkDisplayCategory;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { token } = theme.useToken();
  return (
    <Flex
      component="span"
      align="center"
      justify="center"
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        flex: '0 0 auto',
        lineHeight: 1,
        width: compact ? 34 : 28,
        height: compact ? 24 : 28,
        fontSize: 10,
        fontWeight: compact ? 700 : 800,
        letterSpacing: 0.2,
        borderRadius: compact ? token.borderRadiusSM : token.borderRadiusLG,
        background: token.colorFillTertiary,
        color: disabled ? token.colorTextDisabled : token.colorTextTertiary,
        border: compact ? `1px solid ${token.colorBorderSecondary}` : undefined,
      }}
    >
      {getLinkCompactGlyph(category, disabled)}
    </Flex>
  );
}
