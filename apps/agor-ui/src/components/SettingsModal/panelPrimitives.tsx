import { InfoCircleOutlined } from '@ant-design/icons';
import type { FormItemProps } from 'antd';
import { Divider, Flex, Form, Space, Typography, theme } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

const { Title, Paragraph, Text } = Typography;

/**
 * Shared presentational primitives for the settings panels. Every panel routes
 * its heading, labelled fields, and section breaks through these so the whole
 * modal keeps one vertical rhythm. All spacing/typography is token-driven.
 */

export interface PanelHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Leading brand/tool icon (provider panels). Renders inline with the title. */
  icon?: ReactNode;
  /** Trailing node (e.g. a status Tag on provider panels). */
  extra?: ReactNode;
}

/** One heading shape for every panel; the provider variant is just icon + extra. */
export const PanelHeader: React.FC<PanelHeaderProps> = ({ title, description, icon, extra }) => {
  const { token } = theme.useToken();
  return (
    <div style={{ paddingTop: token.marginLG, marginBottom: 28 }}>
      <Flex align="center" gap={12}>
        {icon}
        <Title level={4} style={{ margin: 0, flex: icon || extra ? 1 : undefined }}>
          {title}
        </Title>
        {extra}
      </Flex>
      {description && (
        <Paragraph type="secondary" style={{ margin: '4px 0 0', maxWidth: 560 }}>
          {description}
        </Paragraph>
      )}
    </div>
  );
};

export interface FieldRowProps {
  label: ReactNode;
  /**
   * Always-visible caption below the control (never a hover-only tooltip).
   * Rendered via Form.Item `extra` (not `help`) so it never triggers Ant's
   * explain margin-offset — which would eat the row's bottom spacing — and so
   * it coexists with, rather than suppresses, validation messages.
   */
  help?: ReactNode;
  /** Renders a red asterisk after the label. Pair with a `required` rule. */
  required?: boolean;
  /** Inline node after the label (e.g. a BETA tag). */
  badge?: ReactNode;
  /** On-hover detail behind an info icon next to the label (keeps panels clean). */
  tooltip?: ReactNode;
  name?: FormItemProps['name'];
  rules?: FormItemProps['rules'];
  valuePropName?: FormItemProps['valuePropName'];
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * A thin `Form.Item` wrapper that standardises label weight, the always-visible
 * help caption, and row rhythm. The one label system for the whole modal.
 */
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
}) => {
  const { token } = theme.useToken();
  return (
    <Form.Item
      name={name}
      rules={rules}
      valuePropName={valuePropName}
      tooltip={tooltip != null ? { title: tooltip, icon: <InfoCircleOutlined /> } : undefined}
      style={{ marginBottom: 22, ...style }}
      label={
        <Space size={4} align="center">
          <Text strong style={{ fontSize: token.fontSize }}>
            {label}
          </Text>
          {badge}
          {required && <Text type="danger">*</Text>}
        </Space>
      }
      extra={
        help != null ? (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {help}
          </Text>
        ) : undefined
      }
    >
      {children}
    </Form.Item>
  );
};

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
