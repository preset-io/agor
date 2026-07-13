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

type LinkCategoryGlyphVariant = 'attachment-medium' | 'attachment-small' | 'row' | 'row-compact';

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

export function LinkCategoryGlyph({
  category,
  variant,
  disabled = false,
  onDark = false,
}: {
  category: LinkDisplayCategory;
  variant: LinkCategoryGlyphVariant;
  disabled?: boolean;
  onDark?: boolean;
}) {
  const { token } = theme.useToken();
  const isAttachment = variant === 'attachment-medium' || variant === 'attachment-small';
  const isAttachmentMedium = variant === 'attachment-medium';
  const isCompactRow = variant === 'row-compact';
  const borderColor = onDark
    ? `color-mix(in srgb, ${token.colorTextLightSolid} 26%, transparent)`
    : token.colorBorderSecondary;

  return (
    <Flex
      component="span"
      vertical={isAttachmentMedium}
      align="center"
      justify="center"
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        flex: '0 0 auto',
        lineHeight: 1,
        width:
          isAttachmentMedium || isAttachment || isCompactRow
            ? isAttachmentMedium
              ? token.controlHeightLG
              : token.controlHeight
            : token.controlHeightSM,
        height: isAttachmentMedium
          ? token.controlHeightLG
          : isAttachment
            ? token.controlHeight
            : token.controlHeightSM,
        fontSize: token.fontSizeIcon,
        fontWeight: token.fontWeightStrong,
        opacity: onDark ? 0.78 : undefined,
        borderRadius: isCompactRow ? token.borderRadiusSM : token.borderRadiusLG,
        background: isAttachment ? undefined : token.colorFillTertiary,
        color: onDark
          ? token.colorTextLightSolid
          : disabled
            ? isAttachment
              ? token.colorTextSecondary
              : token.colorTextDisabled
            : token.colorTextTertiary,
        border: isAttachment || isCompactRow ? `1px solid ${borderColor}` : undefined,
      }}
    >
      {isAttachmentMedium ? (
        <>
          <span style={{ fontSize: token.fontSizeLG }}>
            {getLinkCategoryIcon(category, disabled)}
          </span>
          <span style={{ marginTop: token.sizeXXS }}>{getLinkDisplayGlyphLabel(category)}</span>
        </>
      ) : isAttachment ? (
        getLinkDisplayGlyphLabel(category)
      ) : (
        getLinkCompactGlyph(category, disabled)
      )}
    </Flex>
  );
}
