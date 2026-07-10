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

export function getLinkCategoryLabel(category: LinkDisplayCategory): string {
  return getLinkDisplayGlyphLabel(category);
}

export function getLinkCompactGlyph(
  category: LinkDisplayCategory,
  disabled = false
): React.ReactNode {
  if (disabled || category === 'issue' || category === 'pr') {
    return getLinkCategoryIcon(category, disabled);
  }
  return getLinkCategoryLabel(category);
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
