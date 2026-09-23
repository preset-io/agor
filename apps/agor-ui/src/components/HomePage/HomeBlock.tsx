import { Flex, Typography, theme } from 'antd';
import type React from 'react';

interface HomeBlockProps {
  label: string;
  count?: React.ReactNode;
  /** Right side of the header: quiet links or small controls. */
  actions?: React.ReactNode;
  /** Wrap the body in a soft card (lists); tiles go bare. */
  surface?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

/** A home block: the session panel's uppercase section label over a calm body. */
export const HomeBlock: React.FC<HomeBlockProps> = ({
  label,
  count,
  actions,
  surface = false,
  children,
  style,
}) => {
  const { token } = theme.useToken();
  return (
    <section aria-label={label} style={{ minWidth: 0, ...style }}>
      <Flex
        align="center"
        gap={token.marginXS}
        style={{ minHeight: token.controlHeightSM, marginBottom: token.marginSM }}
      >
        <Typography.Text
          type="secondary"
          style={{
            fontSize: token.fontSizeSM,
            fontWeight: 500,
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </Typography.Text>
        {count !== undefined && (
          <Typography.Text style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
            {count}
          </Typography.Text>
        )}
        <span style={{ flex: 1 }} />
        {actions}
      </Flex>
      {surface ? <HomeSurfaceCard>{children}</HomeSurfaceCard> : children}
    </section>
  );
};

/** Soft card: faint fill and a hairline, no glass or shadow. */
export const HomeSurfaceCard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        background: token.colorFillQuaternary,
        border: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        padding: token.paddingXXS,
      }}
    >
      {children}
    </div>
  );
};

/** Quiet text link for block headers ("View all 12"); colors live in index.css. */
export const HomeLink: React.FC<{
  onClick: () => void;
  children: React.ReactNode;
  ariaLabel?: string;
}> = ({ onClick, children, ariaLabel }) => {
  const { token } = theme.useToken();
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="agor-home-link"
      style={{
        border: 0,
        padding: 0,
        background: 'transparent',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: token.fontSizeSM,
      }}
    >
      {children}
    </button>
  );
};

/** Muted line for empty and loading states inside a block. */
export const HomeEmpty: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = theme.useToken();
  return (
    <Typography.Text
      type="secondary"
      style={{ display: 'block', fontSize: token.fontSizeSM, padding: token.paddingSM }}
    >
      {children}
    </Typography.Text>
  );
};
