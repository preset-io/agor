import { Tag as AntTag, Button, Card, Flex, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import {
  type GalleryFilter,
  galleryCardsForFilter,
  getCategory,
  recommendedTemplateIds,
  TEMPLATE_CATEGORIES,
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

  // Category accent from the shared avatar palette; the blank starter has no
  // category and falls back to neutral tokens.
  const category = getCategory(template.category);
  const accent = category?.color;
  const iconColor = accent ?? token.colorTextSecondary;
  const tileBg = accent ? `${accent}22` : token.colorFillTertiary;

  // Softened, category-colored selection: a 1px accent border (constant width in
  // both states → no layout shift) plus a faint same-hue background wash. No loud
  // blue outline. Blank has no accent, so it uses a quiet neutral treatment.
  const selectedBorder = accent ?? token.colorText;
  const borderColor = selected ? selectedBorder : token.colorBorderSecondary;
  const background = selected ? (accent ? `${accent}14` : token.colorFillQuaternary) : undefined;

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
        // Fill the grid cell so cards in the same row are equal height.
        height: '100%',
        // Constant 1px border in both states — only its color changes on select,
        // so the card never resizes and the row never shifts.
        borderWidth: 1,
        borderColor,
        background,
        cursor: 'pointer',
      }}
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Flex vertical gap={token.marginXS}>
        {/* Tidy top row: colored icon tile + category pill on the left, the
            distinct Recommended badge (blue "processing") on the right. */}
        <Flex align="center" justify="space-between" gap={token.marginXXS}>
          <Flex align="center" gap={token.marginXS}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: token.borderRadius,
                background: tileBg,
              }}
            >
              <Icon style={{ fontSize: token.fontSizeHeading3, color: iconColor }} />
            </span>
            {category && accent && (
              // Category pill in the same hue as the icon. Fills solid when the
              // card is selected (an extra, quiet selection cue).
              <Tag
                style={{
                  margin: 0,
                  fontSize: token.fontSizeSM,
                  color: selected ? token.colorTextLightSolid : accent,
                  background: selected ? accent : `${accent}22`,
                  borderColor: selected ? accent : `${accent}55`,
                }}
              >
                {category.label}
              </Tag>
            )}
          </Flex>
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
 * Responsive 2-column grid of teammate starter templates plus a blank card,
 * with category filter chips above it.
 *
 * Single-select: clicking a card reports its id (blank included). Cards matching
 * the goal-derived recommendations get a "Recommended" badge (up to two; never
 * the blank card) and, in the default "All" view, sort to the front in
 * recommendation order. Filter chips (All · Grow · Build · Operate, plus a
 * Recommended chip when goals produced recommendations) narrow the grid to one
 * category; a ghost "Clear filters" button (shown only when a non-All chip is
 * active) resets to All. The blank starter shows only under All and stays last.
 *
 * Each card carries a category pill and color-coded icon in a shared avatar-
 * palette hue; selecting a card gives it a quiet same-hue border + background
 * wash (no loud blue outline). The grid holds two columns at the modal width,
 * collapses to one only when very narrow, shows full untruncated descriptions,
 * and keeps row-mates equal height. It sits inside the modal's own vertically-
 * scrollable content region so every card is reachable while the wizard footer
 * stays on-screen.
 *
 * Standalone and theme-token driven so it renders correctly both on the
 * onboarding wizard's dark-glass surface and on the standard create-teammate
 * form.
 */
export const TeammateGallery: React.FC<TeammateGalleryProps> = ({ goals, value, onChange }) => {
  const { token } = theme.useToken();
  const goalList = useMemo(() => goals ?? [], [goals]);
  const recommendedIds = useMemo(() => new Set(recommendedTemplateIds(goalList)), [goalList]);
  const hasRecommendations = recommendedIds.size > 0;

  const [filter, setFilter] = useState<GalleryFilter>('all');
  // The Recommended chip only exists while goals produce recommendations; if it
  // disappears (goals cleared) fall back to All rather than showing an empty grid.
  const activeFilter: GalleryFilter =
    filter === 'recommended' && !hasRecommendations ? 'all' : filter;

  const cards = useMemo(
    () => galleryCardsForFilter(goalList, activeFilter),
    [goalList, activeFilter]
  );

  const chips: { key: GalleryFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    ...TEMPLATE_CATEGORIES.map((category) => ({
      key: category.id as GalleryFilter,
      label: category.label,
    })),
    ...(hasRecommendations ? [{ key: 'recommended' as GalleryFilter, label: 'Recommended' }] : []),
  ];

  return (
    <Flex vertical gap={token.marginSM}>
      <Flex
        role="group"
        aria-label="Filter templates by category"
        align="center"
        gap={token.marginXS}
        wrap="wrap"
      >
        {chips.map((chip) => (
          <AntTag.CheckableTag
            key={chip.key}
            checked={activeFilter === chip.key}
            onChange={() => setFilter(chip.key)}
            style={{ cursor: 'pointer', fontSize: token.fontSize, padding: '2px 12px' }}
          >
            {chip.label}
          </AntTag.CheckableTag>
        ))}
        {activeFilter !== 'all' && (
          // Ghost, understated, trailing the chips — clears back to All.
          <Button
            type="text"
            size="small"
            onClick={() => setFilter('all')}
            style={{ marginInlineStart: 'auto', color: token.colorTextSecondary }}
          >
            Clear filters
          </Button>
        )}
      </Flex>

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
        {cards.map((template) => (
          <GalleryCard
            key={template.id}
            template={template}
            selected={value === template.id}
            recommended={recommendedIds.has(template.id)}
            onSelect={() => onChange(template.id)}
          />
        ))}
      </div>
    </Flex>
  );
};
