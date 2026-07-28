import type { FormItemProps } from 'antd';
import { Divider, Flex, Form, Space, Typography, theme } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

const { Title } = Typography;

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
    <Title level={4} style={{ margin: 0, flex: icon || extra ? 1 : undefined }}>
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
    style={style}
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
      orientationMargin={0}
      style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, margin: '8px 0 20px' }}
    >
      {label}
    </Divider>
  );
};
