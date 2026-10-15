import { Button, Card, Flex, Segmented, Typography, theme } from 'antd';
import { useState } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import {
  BLANK_TEMPLATE_ID,
  type GalleryFilter,
  galleryCardsForFilter,
  getCategory,
  TEMPLATE_CATEGORIES,
  type TeammateGalleryCardId,
  type TeammateTemplate,
} from '../../utils/teammateTemplates';
import { getContrastingTextColor } from '../../utils/theme';
import { Tag } from '../Tag';

const { Text, Paragraph } = Typography;

export interface TeammateGalleryProps {
  /** Currently selected template id, or null when nothing is chosen yet. */
  value: TeammateGalleryCardId | null;
  /** Fires with the clicked card's id (the blank starter included). */
  onChange: (templateId: TeammateGalleryCardId) => void;
}

/**
 * Pointer/keyboard handlers for a single-select card. Click or Enter/Space
 * selects; the selected card does nothing, so a custom avatar is never reset
 * ("Start from scratch" is the explicit no-template choice).
 */
function cardSelectHandlers(selected: boolean, onSelect: () => void) {
  const select = () => {
    if (!selected) onSelect();
  };
  return {
    onClick: select,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    },
  };
}

/** A template's antd icon in a quiet square tile (main's blank-starter treatment). */
const TemplateIcon: React.FC<{ icon: TeammateTemplate['icon'] }> = ({ icon: Icon }) => {
  const { token } = theme.useToken();
  return (
    <span
      aria-hidden="true"
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
  );
};

interface GalleryCardProps {
  template: TeammateTemplate;
  selected: boolean;
  compact?: boolean;
  /** Narrow compact cards put the icon above the title so titles keep their width. */
  stacked?: boolean;
  onSelect: () => void;
}

const GalleryCard: React.FC<GalleryCardProps> = ({
  template,
  selected,
  compact,
  stacked,
  onSelect,
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

  const selectHandlers = cardSelectHandlers(selected, onSelect);

  return (
    <Card
      hoverable
      role="button"
      aria-pressed={selected}
      aria-label={template.title}
      tabIndex={0}
      {...selectHandlers}
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
      styles={{ body: { padding: compact ? token.paddingXS : token.paddingSM } }}
    >
      {compact ? (
        <Flex vertical gap={token.marginXXS}>
          <Flex vertical={stacked} align="flex-start" gap={token.marginXS}>
            <TemplateIcon icon={template.icon} />
            <Flex vertical align="flex-start" gap={token.marginXXS} style={{ minWidth: 0 }}>
              <Text strong style={{ fontSize: token.fontSize }}>
                {template.title}
              </Text>
            </Flex>
          </Flex>
          <Paragraph
            type="secondary"
            ellipsis={{ rows: 2, tooltip: template.description }}
            style={{ fontSize: token.fontSizeSM, marginBottom: 0 }}
          >
            {template.description}
          </Paragraph>
        </Flex>
      ) : (
        // Tight internal rhythm (marginXXS) so the card is no taller than its
        // content — keeps the gallery fitting without unnecessary scroll.
        <Flex vertical gap={token.marginXXS}>
          {/* Category pill in the category hue. Fills solid when the card is
            selected (an extra, quiet selection cue). */}
          {category && accent && (
            <Tag
              style={{
                alignSelf: 'flex-start',
                margin: 0,
                fontSize: token.fontSizeSM,
                color: selected ? getContrastingTextColor(accent, token) : accent,
                background: selected ? accent : `${accent}22`,
                borderColor: selected ? accent : `${accent}55`,
              }}
            >
              {category.label}
            </Tag>
          )}
          {/* Title + description flow at their natural height — no ellipsis/clamp, so
            the full copy is always shown. */}
          <Text strong style={{ fontSize: token.fontSize }}>
            {template.title}
          </Text>
          <Paragraph type="secondary" style={{ fontSize: token.fontSizeSM, marginBottom: 0 }}>
            {template.description}
          </Paragraph>
        </Flex>
      )}
    </Card>
  );
};

/**
 * The blank starter in the full gallery, rendered as a full-width card spanning
 * every grid column, before the templates. A deliberately understated "build
 * your own" affordance — dashed neutral border, no category color/pill — laid
 * out horizontally (icon + copy) since it's wide. Still single-selectable with
 * the same softened, no-layout-shift selected state (constant 1px dashed
 * border, only its color changes, plus a faint neutral wash). The compact
 * (onboarding) grid renders it as an ordinary card instead.
 */
const BlankCard: React.FC<{
  template: TeammateTemplate;
  selected: boolean;
  onSelect: () => void;
}> = ({ template, selected, onSelect }) => {
  const { token } = theme.useToken();

  const borderColor = selected ? token.colorText : token.colorBorderSecondary;
  const background = selected ? token.colorFillQuaternary : undefined;

  const selectHandlers = cardSelectHandlers(selected, onSelect);

  return (
    <Card
      hoverable
      role="button"
      aria-pressed={selected}
      aria-label={template.title}
      tabIndex={0}
      {...selectHandlers}
      style={{
        // Span every column of the auto-fit grid → full-width header card.
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
        <TemplateIcon icon={template.icon} />
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

interface TeammateGalleryFiltersProps {
  value: GalleryFilter;
  onChange: (filter: GalleryFilter) => void;
}

/** Exclusive category control for the full gallery. */
const TeammateGalleryFilters: React.FC<TeammateGalleryFiltersProps> = ({ value, onChange }) => {
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
  filter?: GalleryFilter;
  /** Onboarding variant: one even grid of icon + title + one-line description cards. */
  compact?: boolean;
}

/** Card grid, independent of host-specific chrome. */
export const TeammateGalleryCards: React.FC<TeammateGalleryCardsProps> = ({
  value,
  onChange,
  filter = 'all',
  compact,
}) => {
  const { token } = theme.useToken();
  const narrow = useMediaQuery('(max-width: 480px)');
  const cards = galleryCardsForFilter(filter);

  return (
    <fieldset
      aria-label="Teammate template"
      style={{
        display: 'grid',
        gridTemplateColumns: compact
          ? `repeat(${narrow ? 2 : 3}, minmax(0, 1fr))`
          : 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: token.marginXS,
        padding: token.paddingXXS,
        border: 0,
        margin: 0,
        minWidth: 0,
      }}
    >
      {cards.map((template) =>
        template.id === BLANK_TEMPLATE_ID && !compact ? (
          <BlankCard
            key={template.id}
            template={template}
            selected={value === template.id}
            onSelect={() => onChange(template.id)}
          />
        ) : (
          <GalleryCard
            key={template.id}
            template={template}
            selected={value === template.id}
            compact={compact}
            stacked={compact && narrow}
            onSelect={() => onChange(template.id)}
          />
        )
      )}
    </fieldset>
  );
};

/**
 * Reusable teammate-template picker. It owns filtering and optional
 * single-selection, while hosts own navigation chrome and scroll behavior.
 * Onboarding renders the compact card region in its own step wrapper so wizard
 * focus/layout concerns do not leak into this API.
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
