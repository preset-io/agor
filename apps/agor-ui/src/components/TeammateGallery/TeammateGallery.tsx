import { TeamOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Segmented, Tooltip, Typography, theme } from 'antd';
import { Fragment, useState } from 'react';
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
  /**
   * Fires with the clicked card's id (the blank starter included), or `null`
   * when the current pick is cleared (clicking the selected card, or keyboard
   * toggle-off).
   */
  onChange: (templateId: TeammateGalleryCardId | null) => void;
}

/**
 * Shared pointer/keyboard handlers for a single-select card that can also be
 * deselected. Selection is a single-click toggle: clicking an unselected card
 * selects it, clicking the already-selected card clears it. Enter/Space toggles the focused card the same way.
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
  compact?: boolean;
  onSelect: () => void;
  onClear: () => void;
}

const GalleryCard: React.FC<GalleryCardProps> = ({
  template,
  selected,
  compact,
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

  const card = (
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
      styles={{
        body: compact
          ? { padding: token.paddingXS, height: '100%', display: 'flex', alignItems: 'center' }
          : { padding: token.paddingSM },
      }}
    >
      {compact ? (
        <Flex align="center" gap={token.marginXS}>
          <span aria-hidden="true" style={{ fontSize: token.fontSizeLG }}>
            {template.emoji}
          </span>
          <Text strong style={{ fontSize: token.fontSize }}>
            {template.title}
          </Text>
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
  return compact ? (
    <Tooltip title={template.description} trigger={['hover', 'focus']}>
      {card}
    </Tooltip>
  ) : (
    card
  );
};

/**
 * The blank starter, rendered as a full-width header card spanning every grid
 * column (so the eight templates stay a clean grid with no orphan). It leads
 * the All view so picking a template never reads as required. It's a
 * deliberately understated "build your own" affordance — dashed neutral border,
 * no category color/pill, no Recommended badge — laid out horizontally (icon +
 * copy) since it's wide. Still single-selectable with the same softened,
 * no-layout-shift selected state (constant 1px dashed border, only its color
 * changes, plus a faint neutral wash).
 *
 * `recommended` (onboarding) presents the same starter as the default
 * "Team assistant" with a solid border and a Recommended tag.
 */
const BlankCard: React.FC<{
  template: TeammateTemplate;
  selected: boolean;
  recommended?: boolean;
  onSelect: () => void;
  onClear: () => void;
}> = ({ template, selected, recommended, onSelect, onClear }) => {
  const { token } = theme.useToken();
  const Icon = recommended ? TeamOutlined : template.icon;
  const title = recommended ? 'Team assistant' : template.title;
  const description = recommended
    ? 'Works with you and your team. A good place to start.'
    : template.description;

  const borderColor = selected ? token.colorText : token.colorBorderSecondary;
  const background = selected ? token.colorFillQuaternary : undefined;

  const toggleHandlers = useCardToggle(selected, onSelect, onClear);

  return (
    <Card
      hoverable
      role="button"
      aria-pressed={selected}
      aria-label={title}
      tabIndex={0}
      {...toggleHandlers}
      style={{
        // Span every column of the auto-fit grid → full-width header card.
        gridColumn: '1 / -1',
        // Constant 1px dashed border in both states — only the color changes on
        // select, so no layout shift. Dashed + neutral reads as "build your own".
        borderWidth: 1,
        borderStyle: recommended ? 'solid' : 'dashed',
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
          <Flex align="center" wrap gap={token.marginXS}>
            <Text strong style={{ fontSize: token.fontSize }}>
              {title}
            </Text>
            {recommended && (
              <Tag color="processing" style={{ marginInlineEnd: 0, fontSize: token.fontSizeSM }}>
                Recommended
              </Tag>
            )}
          </Flex>
          <Paragraph type="secondary" style={{ fontSize: token.fontSizeSM, marginBottom: 0 }}>
            {description}
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
  filter?: GalleryFilter;
  /** Onboarding variant: recommended blank starter, then emoji + title template cards. */
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
  const cards = galleryCardsForFilter(filter);

  return (
    <fieldset
      aria-label="Teammate template"
      style={{
        display: 'grid',
        // Compact cards keep two per row on phones.
        gridTemplateColumns: compact
          ? `repeat(auto-fit, minmax(min(150px, calc(50% - ${token.marginXS / 2}px)), 1fr))`
          : 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: token.marginXS,
        padding: token.paddingXXS,
        border: 0,
        margin: 0,
        minWidth: 0,
      }}
    >
      {cards.map((template) =>
        template.id === BLANK_TEMPLATE_ID ? (
          <Fragment key={template.id}>
            <BlankCard
              template={template}
              selected={value === template.id}
              recommended={compact}
              onSelect={() => onChange(template.id)}
              onClear={() => onChange(null)}
            />
            {compact && (
              <Text type="secondary" style={{ gridColumn: '1 / -1', marginTop: token.marginXS }}>
                Or start from a template
              </Text>
            )}
          </Fragment>
        ) : (
          <GalleryCard
            key={template.id}
            template={template}
            selected={value === template.id}
            compact={compact}
            onSelect={() => onChange(template.id)}
            onClear={() => onChange(null)}
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
