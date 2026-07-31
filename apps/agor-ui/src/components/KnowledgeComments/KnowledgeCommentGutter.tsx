import { CommentOutlined } from '@ant-design/icons';
import { Badge, Button, Tooltip, theme } from 'antd';
import type { KnowledgeAnchorSummary, MeasuredHeading } from './knowledgeCommentAnchors';
import './KnowledgeCommentGutter.css';

/** Width reserved to the left of the document body for comment affordances. */
export const KNOWLEDGE_COMMENT_GUTTER_WIDTH = 32;

interface KnowledgeCommentGutterProps {
  headings: MeasuredHeading[];
  summary: KnowledgeAnchorSummary;
  /** Section currently shown in the panel, highlighted in the margin. */
  activeSlug: string | null;
  onSelectSection: (heading: MeasuredHeading) => void;
}

/**
 * Google-Docs-style margin affordances: a comment button beside every section
 * heading, always visible once a section has threads and revealed on hover
 * otherwise (via CSS `:hover` on the parent, which inline styles cannot express).
 */
export const KnowledgeCommentGutter: React.FC<KnowledgeCommentGutterProps> = ({
  headings,
  summary,
  activeSlug,
  onSelectSection,
}) => {
  const { token } = theme.useToken();

  return (
    <div
      aria-hidden={headings.length === 0}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: KNOWLEDGE_COMMENT_GUTTER_WIDTH,
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      {headings.map((heading) => {
        const total = summary.totalBySlug.get(heading.slug) ?? 0;
        const unresolved = summary.unresolvedBySlug.get(heading.slug) ?? 0;
        const isActive = heading.slug === activeSlug;

        return (
          <div
            key={heading.slug}
            className={total > 0 ? undefined : 'knowledge-comment-gutter-hoverable'}
            style={{
              position: 'absolute',
              top: heading.top,
              left: 0,
              pointerEvents: 'auto',
            }}
          >
            <Tooltip
              title={total > 0 ? `${total} comment${total === 1 ? '' : 's'}` : 'Comment on section'}
              placement="left"
            >
              <Badge count={unresolved} size="small" offset={[-4, 4]}>
                <Button
                  type={isActive ? 'primary' : 'text'}
                  size="small"
                  icon={<CommentOutlined />}
                  onClick={() => onSelectSection(heading)}
                  aria-label={`Comments on section: ${heading.text}`}
                  style={total > 0 || isActive ? undefined : { color: token.colorTextTertiary }}
                />
              </Badge>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
};
