import { Tag as AntTag, Button, Card, Flex, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import {
  BLANK_TEMPLATE_ID,
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
  /**
   * Fires with the clicked card's id (the blank starter included), or `null`
   * when the current pick is cleared (clicking the selected card, or keyboard
   * toggle-off).
   */
  onChange: (templateId: string | null) => void;
  /**
   * Optional content placed above the filter chips inside the non-scrolling
   * header region (e.g. a title/intro + name field + section label). It stays
   * fixed while only the card grid scrolls, in its own region below.
   */
  header?: React.ReactNode;
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
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
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
      role="radio"
      aria-checked={selected}
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
      <Flex vertical gap={token.marginXS}>
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
                color: selected ? token.colorTextLightSolid : accent,
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
      role="radio"
      aria-checked={selected}
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

/**
 * Responsive 2-column grid of teammate starter templates plus a blank card,
 * with category filter chips above it.
 *
 * Single-select via a single-click toggle (like the step-1 goal cards): clicking
 * an unselected card selects it and reports its id (blank included); clicking the
 * already-selected card — or pressing Enter/Space on it — clears the pick
 * (`onChange(null)`), since selecting a template is optional. Cards matching
 * the goal-derived recommendations get a "Recommended" badge (up to two; never
 * the blank card) and, in the default "All" view, sort to the front in
 * recommendation order. Filter chips (All · Grow · Build · Operate) narrow the
 * grid to one category; a ghost "Clear filters" button (shown only when a
 * non-All chip is active) resets to All. The blank starter shows only under All
 * and stays last.
 *
 * Each card carries a category pill in a shared avatar-palette hue (no icon
 * tile); selecting a card gives it a quiet same-hue border + background wash (no
 * loud blue outline). The grid holds three columns at the modal width, stepping
 * down to two (then one) only as the container narrows, shows full untruncated
 * descriptions, and keeps row-mates equal height.
 *
 * Layout is TWO PHYSICAL REGIONS in a flex column that fills its parent's
 * height: a non-scrolling header block (`flex: 0 0 auto`) holding any `header`
 * content plus the filter chips, and a separate scroll region
 * (`flex: 1 1 auto; min-height: 0; overflow-y: auto`) holding ONLY the card
 * grid. Because the grid lives in its own `overflow` container, the browser
 * clips the cards to it — they can never paint over the header in any engine (a
 * structural guarantee that replaces the earlier, engine-dependent
 * `position: sticky` + z-index approach).
 *
 * Standalone and theme-token driven so it renders correctly both on the
 * onboarding wizard's dark-glass surface and on the standard create-teammate
 * form.
 */
export const TeammateGallery: React.FC<TeammateGalleryProps> = ({
  goals,
  value,
  onChange,
  header,
}) => {
  const { token } = theme.useToken();
  const goalList = useMemo(() => goals ?? [], [goals]);
  const recommendedIds = useMemo(() => new Set(recommendedTemplateIds(goalList)), [goalList]);

  const [filter, setFilter] = useState<GalleryFilter>('all');

  const cards = useMemo(() => galleryCardsForFilter(goalList, filter), [goalList, filter]);

  const chips: { key: GalleryFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    ...TEMPLATE_CATEGORIES.map((category) => ({
      key: category.id as GalleryFilter,
      label: category.label,
    })),
  ];

  return (
    // Two physical regions in a flex column that fills the parent's height (the
    // host mounts it inside a flex column). The header block never scrolls; the
    // grid lives in its own overflow container below, so cards are clipped to it
    // and can never paint over the header.
    <Flex vertical style={{ flex: '1 1 auto', minHeight: 0 }}>
      {/* Non-scrolling header: the optional host content (title/intro + name
          field + label) plus the filter chips stay fixed above the card region. */}
      <Flex
        vertical
        gap={token.marginSM}
        style={{ flex: '0 0 auto', paddingBottom: token.paddingSM }}
      >
        {header}
        <Flex
          role="group"
          aria-label="Filter templates by category"
          align="center"
          gap={token.marginXS}
          wrap="wrap"
        >
          {chips.map((chip) => {
            const active = filter === chip.key;
            return (
              <AntTag.CheckableTag
                key={chip.key}
                checked={active}
                onChange={() => setFilter(chip.key)}
                // Explicit, deterministic styling in both states so inactive chips
                // always look identical: a bordered transparent pill, with only the
                // active chip filled. Inline styles also override antd's hover-fill,
                // so no chip is left with a stuck grey box.
                style={{
                  cursor: 'pointer',
                  fontSize: token.fontSize,
                  padding: '2px 12px',
                  borderRadius: token.borderRadius,
                  border: `1px solid ${active ? token.colorPrimary : token.colorBorderSecondary}`,
                  background: active ? token.colorPrimary : 'transparent',
                  color: active ? token.colorTextLightSolid : token.colorText,
                }}
              >
                {chip.label}
              </AntTag.CheckableTag>
            );
          })}
          {filter !== 'all' && (
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
      </Flex>

      {/* Scroll region: its OWN overflow container, so the browser clips the
          cards to it. This is what makes overlap impossible by construction —
          a card can never render above the sibling header block. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <div
          role="radiogroup"
          aria-label="Teammate template"
          style={{
            display: 'grid',
            // Three columns at the ~730px modal width; each column floors at 190px
            // so the row steps down to 2 (then 1) only on a narrower container.
            // 190px is the widest floor that still packs 3 columns into the step-2
            // content width without ever admitting a 4th.
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: token.marginSM,
            // Room for card focus rings at the grid edges.
            padding: token.paddingXXS,
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
        </div>
      </div>
    </Flex>
  );
};
