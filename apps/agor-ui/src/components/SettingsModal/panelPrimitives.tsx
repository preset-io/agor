import type { FormItemProps } from 'antd';
import { Divider, Flex, Form, Space, Typography, theme } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

const { Title } = Typography;

/**
 * Shared field-width contract for every Settings drill-in form.
 *
 * Field width should roughly match the expected input length: a field far wider
 * than what you'd type into it misleads the user about what's expected and makes
 * it harder to eyeball-verify what they typed (NN/g "Website Forms Usability";
 * Wroblewski, "Web Form Design"). Before this, width was decided ad hoc per
 * field via ~5 different mechanisms, so the same "420px Select above a
 * full-bleed API-key Input" contradiction recurred across the modal.
 *
 * Values are `maxWidth` (not `width`) so a field still shrinks on a narrow
 * viewport but is capped on a wide one. `full` applies no cap — reserve it for
 * genuinely long-form content (URLs, textareas, JSON/YAML/PEM, code editors).
 *
 * Use via `FieldRow`'s `width` prop, or spread directly onto a raw control's
 * `style` for the many fields that don't go through `FieldRow`
 * (e.g. `style={{ ...FIELD_WIDTHS.short }}`).
 */
export const FIELD_WIDTHS = {
  /** ~short numeric fields: ports, durations, poll intervals, small counts. */
  tiny: { maxWidth: 160 },
  /** Fixed-format short strings: API keys, tokens, slugs, names, small enum Selects. */
  short: { maxWidth: 420 },
  /** Emails, medium identifiers, multi-select tag pickers. */
  medium: { maxWidth: 560 },
  /** No cap — long-form content only (URLs, descriptions, JSON/YAML/PEM, code). */
  full: {},
} as const satisfies Record<string, CSSProperties>;

export type FieldWidth = keyof typeof FIELD_WIDTHS;

export interface ListPanelHeaderProps {
  /** Persistent panel title — always shown, even though the nav highlights it. */
  title: ReactNode;
  /** One-line description, rendered on its own line directly under the title. */
  description?: ReactNode;
  /** Search input; sits at the left of the toolbar row. */
  search?: ReactNode;
  /** Create/import actions; sit at the right of the toolbar row. */
  actions?: ReactNode;
}

/**
 * Standard header for a Workspace Settings list panel: a persistent title, the
 * description on its own line below it, then a separate toolbar row with search
 * on the left and actions on the right. Mirrors the mockup's PanelHeader +
 * TableToolbar so every list panel reads the same.
 */
export const ListPanelHeader: React.FC<ListPanelHeaderProps> = ({
  title,
  description,
  search,
  actions,
}) => {
  const { token } = theme.useToken();
  return (
    <div style={{ marginBottom: token.marginMD }}>
      <Title level={4} style={{ margin: 0, fontWeight: 500 }}>
        {title}
      </Title>
      {description && (
        <Typography.Paragraph
          type="secondary"
          style={{ marginTop: token.marginXXS, marginBottom: 0 }}
        >
          {description}
        </Typography.Paragraph>
      )}
      {(search || actions) && (
        <Flex
          align="center"
          justify="space-between"
          gap={token.marginSM}
          style={{ marginTop: token.marginMD }}
        >
          <div>{search}</div>
          {actions && <Space>{actions}</Space>}
        </Flex>
      )}
    </div>
  );
};

/**
 * Shared presentational primitives for the settings panels. Output mirrors the
 * app-standard (master) form styling; the panels only rely on these so the
 * heading and section breaks stay consistent.
 */

export interface PanelHeaderProps {
  title: ReactNode;
  /** Leading brand/tool icon (provider panels). Renders inline with the title. */
  icon?: ReactNode;
  /** Trailing node (e.g. a status Tag on provider panels). */
  extra?: ReactNode;
}

/** Section title; the provider variant adds a leading icon and a trailing tag. */
export const PanelHeader: React.FC<PanelHeaderProps> = ({ title, icon, extra }) => (
  <Flex align="center" gap={12} style={{ marginBottom: 20 }}>
    {icon}
    {/* Size, not boldness, carries hierarchy: regular/medium weight. */}
    <Title level={4} style={{ margin: 0, flex: icon || extra ? 1 : undefined, fontWeight: 500 }}>
      {title}
    </Title>
    {extra}
  </Flex>
);

export interface FieldRowProps {
  label: ReactNode;
  /** Persistent note under the field (Ant `help`). Use for essential notes only. */
  help?: ReactNode;
  /** Marks the field required (shows Ant's asterisk). */
  required?: boolean;
  /** Inline node after the label (e.g. a BETA tag). */
  badge?: ReactNode;
  /** On-hover detail behind the label's info icon (Ant `tooltip`). */
  tooltip?: ReactNode;
  name?: FormItemProps['name'];
  rules?: FormItemProps['rules'];
  valuePropName?: FormItemProps['valuePropName'];
  /**
   * Caps the field width to a shared tier (see `FIELD_WIDTHS`) so it matches the
   * expected input length. Omit for the default (no cap). An explicit `style`
   * maxWidth still wins.
   */
  width?: FieldWidth;
  style?: CSSProperties;
  children: ReactNode;
}

/** A thin `Form.Item` wrapper; renders identically to a plain app form field. */
export const FieldRow: React.FC<FieldRowProps> = ({
  label,
  help,
  required,
  badge,
  tooltip,
  name,
  rules,
  valuePropName,
  width,
  style,
  children,
}) => (
  <Form.Item
    name={name}
    rules={rules}
    required={required}
    valuePropName={valuePropName}
    tooltip={tooltip}
    help={help}
    style={{ ...(width ? FIELD_WIDTHS[width] : undefined), ...style }}
    label={
      badge != null ? (
        <Space size={4}>
          {label}
          {badge}
        </Space>
      ) : (
        label
      )
    }
  >
    {children}
  </Form.Item>
);

export interface SectionDividerProps {
  label: ReactNode;
}

/** Left-aligned, muted section break between groups of fields within a panel. */
export const SectionDivider: React.FC<SectionDividerProps> = ({ label }) => {
  const { token } = theme.useToken();
  return (
    <Divider
      titlePlacement="left"
      styles={{ content: { margin: 0 } }}
      style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, margin: '8px 0 20px' }}
    >
      {label}
    </Divider>
  );
};
