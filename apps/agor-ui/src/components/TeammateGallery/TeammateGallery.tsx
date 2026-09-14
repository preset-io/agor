import { Button, Card, Flex, Segmented, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import {
  BLANK_TEMPLATE_ID,
  type GalleryFilter,
  galleryCardsForFilter,
  getCategory,
  recommendedTemplateIds,
  TEMPLATE_CATEGORIES,
  type TeammateGalleryCardId,
  type TeammateTemplate,
} from '../../utils/teammateTemplates';
import { getContrastingTextColor } from '../../utils/theme';
import { Tag } from '../Tag';

const { Text, Paragraph } = Typography;

export interface TeammateGalleryProps {
  /** Selected goal ids (onboarding). Drives which cards get a Recommended badge. */
  goals?: readonly string[];
  /** Currently selected template id, or null when nothing is chosen yet. */
  value: TeammateGalleryCardId | null;
  /**
   * Fires with the clicked card's id (the blank starter included), or `null`
   * when the current pick is cleared (clicking the selected card, or keyboard
   * toggle-off).
   */
  onChange: (templateId: TeammateGalleryCardId | null) => void;
}

/**
 * Shared pointer/keyboard handlers for a single-select card that can also be
 * deselected. Selection is a single-click toggle (matching the step-1 goal
 * cards): clicking an unselected card selects it, clicking the already-selected
 * card clears it. Enter/Space toggles the focused card the same way.
 */
function useCardToggle(selected: boolean, onSelect: () => void, onClear: () => void) {
  const toggle = () => (selected ? onClear() : onSelect());
  return {
    onClick: toggle,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    },
  };
}

interface GalleryCardProps {
  template: TeammateTemplate;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
  onClear: () => void;
}

const GalleryCard: React.FC<GalleryCardProps> = ({
  template,
  selected,
  recommended,
  onSelect,
  onClear,
}) => {
  const { token } = theme.useToken();

  // Category accent from the shared avatar palette; the blank starter has no
  // category and falls back to neutral tokens. The colored category tag (below)
  // is now the sole carrier of the category hue — the icon tile was removed.
  const category = getCategory(template.category);
  const accent = category?.color;

  // Softened, category-colored selection: a 1px accent border (constant width in
  // both states → no layout shift) plus a faint same-hue background wash. No loud
  // blue outline. Blank has no accent, so it uses a quiet neutral treatment.
  const selectedBorder = accent ?? token.colorText;
  const borderColor = selected ? selectedBorder : token.colorBorderSecondary;
  const background = selected ? (accent ? `${accent}14` : token.colorFillQuaternary) : undefined;

  const toggleHandlers = useCardToggle(selected, onSelect, onClear);

  return (
    <Card
      hoverable
      role="button"
      aria-pressed={selected}
      aria-label={template.title}
      tabIndex={0}
      {...toggleHandlers}
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
      {/* Tight internal rhythm (marginXXS) so the card is no taller than its
          content — keeps the gallery fitting without unnecessary scroll. */}
      <Flex vertical gap={token.marginXXS}>
        {/* Tidy top row: the colored category pill on the left carries the category
            hue (the icon tile was removed); the distinct Recommended badge (blue
            "processing") sits on the right. */}
        <Flex align="center" justify="space-between" gap={token.marginXXS}>
          {category && accent ? (
            // Category pill in the category hue. Fills solid when the card is
            // selected (an extra, quiet selection cue).
            <Tag
              style={{
                margin: 0,
                fontSize: token.fontSizeSM,
                color: selected ? getContrastingTextColor(accent, token) : accent,
                background: selected ? accent : `${accent}22`,
                borderColor: selected ? accent : `${accent}55`,
              }}
            >
              {category.label}
            </Tag>
          ) : (
            // Keep the badge right-aligned even when there's no category pill.
            <span />
          )}
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
 * The blank starter, rendered as a full-width footer card spanning both grid
 * columns (so the eight templates stay a clean 4×2 grid with no orphan). It's a
 * deliberately understated "build your own" affordance — dashed neutral border,
 * no category color/pill, no Recommended badge — laid out horizontally (icon +
 * copy) since it's wide. Still single-selectable with the same softened,
 * no-layout-shift selected state (constant 1px dashed border, only its color
 * changes, plus a faint neutral wash).
 */
const BlankCard: React.FC<{
  template: TeammateTemplate;
  selected: boolean;
  onSelect: () => void;
  onClear: () => void;
}> = ({ template, selected, onSelect, onClear }) => {
  const { token } = theme.useToken();
  const Icon = template.icon;

  const borderColor = selected ? token.colorText : token.colorBorderSecondary;
  const background = selected ? token.colorFillQuaternary : undefined;

  const toggleHandlers = useCardToggle(selected, onSelect, onClear);

  return (
    <Card
      hoverable
      role="button"
      aria-pressed={selected}
      aria-label={template.title}
      tabIndex={0}
      {...toggleHandlers}
      style={{
        // Span every column of the auto-fit grid → full-width footer card.
        gridColumn: '1 / -1',
        // Constant 1px dashed border in both states — only the color changes on
        // select, so no layout shift. Dashed + neutral reads as "build your own".
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor,
        background,
        cursor: 'pointer',
      }}
      styles={{ body: { padding: token.paddingSM } }}
    >
      <Flex align="center" gap={token.margin}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: token.borderRadius,
            background: token.colorFillTertiary,
            flex: '0 0 auto',
          }}
        >
          <Icon style={{ fontSize: token.fontSizeHeading3, color: token.colorTextSecondary }} />
        </span>
        <Flex vertical gap={token.marginXXS}>
          <Text strong style={{ fontSize: token.fontSize }}>
            {template.title}
          </Text>
          <Paragraph type="secondary" style={{ fontSize: token.fontSizeSM, marginBottom: 0 }}>
            {template.description}
          </Paragraph>
        </Flex>
      </Flex>
    </Card>
  );
};

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  ...TEMPLATE_CATEGORIES.map((category) => ({
    value: category.id,
    label: category.label,
  })),
] satisfies { value: GalleryFilter; label: string }[];

export interface TeammateGalleryFiltersProps {
  value: GalleryFilter;
  onChange: (filter: GalleryFilter) => void;
}

/** Exclusive category control shared by every gallery host. */
export const TeammateGalleryFilters: React.FC<TeammateGalleryFiltersProps> = ({
  value,
  onChange,
}) => {
  const { token } = theme.useToken();

  return (
    <Flex align="center" gap={token.marginXS} wrap="wrap">
      <Segmented<GalleryFilter>
        aria-label="Filter templates by category"
        options={FILTER_OPTIONS}
        value={value}
        onChange={onChange}
        shape="round"
        size="small"
        styles={{
          item: { fontSize: token.fontSize, paddingInline: token.paddingSM },
        }}
      />
      {value !== 'all' && (
        <Button
          type="text"
          size="small"
          onClick={() => onChange('all')}
          style={{ marginInlineStart: 'auto', color: token.colorTextSecondary }}
        >
          Clear filters
        </Button>
      )}
    </Flex>
  );
};

export interface TeammateGalleryCardsProps extends TeammateGalleryProps {
  filter: GalleryFilter;
}

/** Card grid and recommendation ordering, independent of host-specific chrome. */
export const TeammateGalleryCards: React.FC<TeammateGalleryCardsProps> = ({
  goals,
  value,
  onChange,
  filter,
}) => {
  const { token } = theme.useToken();
  const goalList = useMemo(() => goals ?? [], [goals]);
  const recommendedIds = useMemo(() => new Set(recommendedTemplateIds(goalList)), [goalList]);
  const cards = useMemo(() => galleryCardsForFilter(goalList, filter), [goalList, filter]);

  return (
    <fieldset
      aria-label="Teammate template"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: token.marginXS,
        padding: token.paddingXXS,
        border: 0,
        margin: 0,
        minWidth: 0,
      }}
    >
      {cards.map((template) =>
        template.id === BLANK_TEMPLATE_ID ? (
          <BlankCard
            key={template.id}
            template={template}
            selected={value === template.id}
            onSelect={() => onChange(template.id)}
            onClear={() => onChange(null)}
          />
        ) : (
          <GalleryCard
            key={template.id}
            template={template}
            selected={value === template.id}
            recommended={recommendedIds.has(template.id)}
            onSelect={() => onChange(template.id)}
            onClear={() => onChange(null)}
          />
        )
      )}
    </fieldset>
  );
};

/**
 * Reusable teammate-template picker. It owns filtering, recommendation order,
 * and optional single-selection, while hosts own navigation chrome and scroll
 * behavior. Onboarding composes the same filter and card regions in its own
 * step wrapper so wizard focus/layout concerns do not leak into this API.
 */
export const TeammateGallery: React.FC<TeammateGalleryProps> = (props) => {
  const { token } = theme.useToken();
  const [filter, setFilter] = useState<GalleryFilter>('all');

  return (
    <Flex vertical gap={token.marginSM}>
      <TeammateGalleryFilters value={filter} onChange={setFilter} />
      <TeammateGalleryCards {...props} filter={filter} />
    </Flex>
  );
};
