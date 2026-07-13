import { Button, Flex, theme } from 'antd';
import type React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import type { LinkDisplayNavigation } from './linkDisplay';
import styles from './linkUi.module.css';

interface ActionLinkRowProps {
  children: React.ReactNode;
  onActivate?: () => void;
  ariaLabel: string;
  href?: string;
  navigation?: LinkDisplayNavigation;
  actions?: React.ReactNode;
  disabled?: boolean;
  compact?: boolean;
  bordered?: boolean;
}

/**
 * Shared accessible row for link collections. The primary target is a native
 * Ant Design button and secondary actions are siblings, so keyboard, focus,
 * disabled, and nested-action behavior do not need to be rebuilt per surface.
 */
export function ActionLinkRow({
  children,
  onActivate,
  ariaLabel,
  href,
  navigation,
  actions,
  disabled = false,
  compact = false,
  bordered = false,
}: ActionLinkRowProps) {
  const { token } = theme.useToken();
  const primaryPadding = compact
    ? `${token.sizeXXS}px ${token.sizeXS}px`
    : `${token.sizeSM}px ${token.sizeXS}px`;
  const primary =
    href && !disabled && navigation === 'spa' ? (
      <RouterLink
        className={styles.actionRowLink}
        aria-label={ariaLabel}
        to={href}
        onClick={onActivate}
        style={{
          display: 'flex',
          minWidth: 0,
          flex: 1,
          alignItems: 'stretch',
          color: 'var(--agor-action-row-link-color, inherit)',
          textDecoration: 'none',
          padding: primaryPadding,
        }}
      >
        {children}
      </RouterLink>
    ) : (
      <Button
        type="text"
        block
        href={href && !disabled ? href : undefined}
        target={href && navigation === 'external' ? '_blank' : undefined}
        rel={href && navigation === 'external' ? 'noreferrer' : undefined}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={onActivate}
        style={{
          height: 'auto',
          minWidth: 0,
          flex: 1,
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          whiteSpace: 'normal',
          textAlign: 'left',
          padding: primaryPadding,
        }}
      >
        {children}
      </Button>
    );

  return (
    <Flex
      align="center"
      gap={token.sizeXS}
      style={{
        width: '100%',
        minWidth: 0,
        borderBottom: bordered ? `1px solid ${token.colorBorderSecondary}` : undefined,
        borderRadius: token.borderRadius,
      }}
    >
      {primary}
      {actions && (
        <Flex align="center" gap={token.sizeXXS} style={{ flex: '0 0 auto' }}>
          {actions}
        </Flex>
      )}
    </Flex>
  );
}
