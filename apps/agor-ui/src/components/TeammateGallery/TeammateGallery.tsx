import { Card, Flex, Typography, theme } from 'antd';
import { useMemo } from 'react';
import {
  recommendedTemplateIds,
  TEAMMATE_GALLERY_CARDS,
  type TeammateTemplate,
} from '../../utils/teammateTemplates';
import { Tag } from '../Tag';

const { Text, Paragraph } = Typography;

export interface TeammateGalleryProps {
  /** Selected goal ids (onboarding). Drives which cards get a Recommended badge. */
  goals?: string[];
  /** Currently selected template id, or null when nothing is chosen yet. */
  value: string | null;
  /** Fires with the clicked card's id (the blank starter included). */
  onChange: (templateId: string) => void;
}

const CARD_WIDTH = 168;

interface GalleryCardProps {
  template: TeammateTemplate;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
}

const GalleryCard: React.FC<GalleryCardProps> = ({ template, selected, recommended, onSelect }) => {
  const { token } = theme.useToken();
  const Icon = template.icon;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect();
  };

  return (
    <Card
      hoverable
      role="radio"
      aria-checked={selected}
      aria-label={template.title}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      style={{
        flex: '0 0 auto',
        width: CARD_WIDTH,
        scrollSnapAlign: 'start',
        // Constant 2px border in both states — only the color changes on select,
        // so the card never resizes and the row never shifts (no re-click bait).
        borderWidth: 2,
        borderColor: selected ? token.colorPrimary : token.colorBorderSecondary,
        cursor: 'pointer',
      }}
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Flex vertical gap={token.marginXS}>
        <Flex align="center" justify="space-between" gap={token.marginXXS}>
          <Icon
            style={{
              fontSize: token.fontSizeHeading3,
              color: selected ? token.colorPrimary : token.colorTextSecondary,
            }}
          />
          {recommended && (
            <Tag color="processing" style={{ marginInlineEnd: 0, fontSize: token.fontSizeSM }}>
              Recommended
            </Tag>
          )}
        </Flex>
        <Text strong ellipsis={{ tooltip: template.title }} style={{ fontSize: token.fontSize }}>
          {template.title}
        </Text>
        <Paragraph
          type="secondary"
          ellipsis={{ rows: 3, tooltip: template.description }}
          style={{
            fontSize: token.fontSizeSM,
            marginBottom: 0,
            // Reserve three lines so every card keeps the same height regardless
            // of copy length (matches the equal-height goal cards from #2293).
            minHeight: `calc(${token.fontSizeSM}px * ${token.lineHeight} * 3)`,
          }}
        >
          {template.description}
        </Paragraph>
      </Flex>
    </Card>
  );
};

/**
 * Horizontally-scrolling gallery of teammate starter templates plus a blank
 * card. Single-select: clicking a card reports its id (blank included). Cards
 * matching the goal-derived recommendations get a "Recommended" badge (up to
 * two; never the blank card).
 *
 * Standalone and theme-token driven so it renders correctly both on the
 * onboarding wizard's dark-glass surface and on the standard create-teammate
 * form.
 */
export const TeammateGallery: React.FC<TeammateGalleryProps> = ({ goals, value, onChange }) => {
  const { token } = theme.useToken();
  const recommendedIds = useMemo(() => new Set(recommendedTemplateIds(goals ?? [])), [goals]);

  return (
    <div
      role="radiogroup"
      aria-label="Teammate template"
      style={{
        display: 'flex',
        gap: token.marginSM,
        overflowX: 'auto',
        // Room for the focus ring + a hint that the row scrolls.
        paddingBottom: token.paddingXS,
        scrollSnapType: 'x proximity',
      }}
    >
      {TEAMMATE_GALLERY_CARDS.map((template) => (
        <GalleryCard
          key={template.id}
          template={template}
          selected={value === template.id}
          recommended={recommendedIds.has(template.id)}
          onSelect={() => onChange(template.id)}
        />
      ))}
    </div>
  );
};
