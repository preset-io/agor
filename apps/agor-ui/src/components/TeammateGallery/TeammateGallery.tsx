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
        // Fill the grid cell so cards in the same row are equal height, aligned
        // to the tallest in that row.
        height: '100%',
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
        {/* Title + description flow at their natural height — no ellipsis/clamp, so
            the full copy is always shown (matches the step-1 goal cards). */}
        <Text strong style={{ fontSize: token.fontSize }}>
          {template.title}
        </Text>
        <Paragraph type="secondary" style={{ fontSize: token.fontSizeSM, marginBottom: 0 }}>
          {template.description}
        </Paragraph>
      </Flex>
    </Card>
  );
};

/**
 * Responsive 2-column grid of teammate starter templates plus a blank card.
 * Single-select: clicking a card reports its id (blank included). Cards matching
 * the goal-derived recommendations get a "Recommended" badge (up to two; never
 * the blank card).
 *
 * The grid holds two columns at the modal's width and collapses to one only when
 * the container gets very narrow. Descriptions are shown in full (no truncation);
 * cards in a row share the tallest card's height. It sits inside the modal's own
 * vertically-scrollable content region, so every card is reachable by normal
 * vertical scroll while the wizard footer stays on-screen.
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
        display: 'grid',
        // Two columns at the ~600px modal width; each column is at least 220px so
        // the row collapses to a single column only on a very narrow container.
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: token.marginSM,
        // Room for card focus rings at the grid edges.
        padding: token.paddingXXS,
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
