import { InfoCircleOutlined } from '@ant-design/icons';
import type { ButtonProps } from 'antd';
import {
  Alert,
  Button,
  ConfigProvider,
  Drawer,
  Flex,
  Skeleton,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { createContext, useContext, useRef } from 'react';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { isDarkTheme } from '../../utils/theme';
import { GlassPanel } from '../GlassSurface/GlassPanel';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';

const HomeDensity = createContext(false);

/** Phone density, read once by HomeFrame: labels collapse and controls grow to touch size below `md`. */
export const useHomeCompact = () => useContext(HomeDensity);

const TOUCH_THEME = {
  token: { controlHeight: MOBILE_TOUCH_TARGET, controlHeightSM: MOBILE_TOUCH_TARGET },
};
const NO_THEME = {};

/** Scrolling page frame shared by Home and the teammates directory. */
export const HomeFrame: React.FC<{ children: React.ReactNode; maxWidth?: number }> = ({
  children,
  maxWidth = 1320,
}) => {
  const { token } = theme.useToken();
  // Correct on the first render, so the frame never swaps its tree after mount.
  const compact = !useMediaQuery(`(min-width: ${token.screenMD}px)`);
  return (
    <ConfigProvider theme={compact ? TOUCH_THEME : NO_THEME}>
      <HomeDensity.Provider value={compact}>
        <div
          style={{
            height: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            background: DEFAULT_BACKGROUNDS[isDarkTheme(token) ? 'dark' : 'light'],
          }}
        >
          <Flex
            vertical
            gap={compact ? token.marginMD : token.marginLG}
            style={{
              maxWidth,
              margin: '0 auto',
              padding: compact
                ? `${token.padding}px ${token.padding}px ${token.paddingXL}px`
                : `${token.paddingLG}px ${token.paddingXL}px 80px`,
            }}
          >
            {children}
          </Flex>
        </div>
      </HomeDensity.Provider>
    </ConfigProvider>
  );
};

/** Secondary link: neutral text that takes the primary color on hover and focus. */
export const HomeLink: React.FC<ButtonProps> = (props) => (
  <Button color="default" variant="link" size="small" className="agor-home-link" {...props} />
);

/**
 * Home's in-place "show more": a quiet link in the list's last row, aligned with row
 * text. On reveal, focus moves to the first new row. The count never truncates; the detail can.
 */
export const HomeShowMore: React.FC<{
  label: string;
  detail?: string;
  /** Set for a two-way toggle (aria-expanded); omit when it only loads more. */
  expanded?: boolean;
  onClick: () => void;
}> = ({ label, detail, expanded, onClick }) => {
  const { token } = theme.useToken();
  const ref = useRef<HTMLDivElement>(null);
  const reveal = () => {
    const list = ref.current?.parentElement;
    const from = list?.querySelectorAll('[data-home-row]').length ?? 0;
    onClick();
    requestAnimationFrame(() =>
      list?.querySelectorAll<HTMLElement>('[data-home-row]')[from]?.focus()
    );
  };
  return (
    <div
      ref={ref}
      style={{
        padding: `${token.paddingXXS}px ${token.paddingSM}px`,
        paddingInlineStart: token.paddingSM + 20 + token.marginSM,
      }}
    >
      <HomeLink
        aria-expanded={expanded}
        aria-label={detail ? `${label} · ${detail}` : label}
        onClick={expanded ? onClick : reveal}
        style={{ paddingInline: 0, marginInlineStart: -token.lineWidth, maxWidth: '100%' }}
        styles={{ content: { minWidth: 0 } }}
      >
        <span style={{ display: 'flex', minWidth: 0 }}>
          <span style={{ flex: '0 0 auto' }}>{label}</span>
          {detail && (
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'pre',
              }}
            >
              {` · ${detail}`}
            </span>
          )}
        </span>
      </HomeLink>
    </div>
  );
};

/** Phone bottom sheet for Home's pickers and filters. */
export const HomeSheet: React.FC<{
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ open, title, onClose, children }) => {
  const { token } = theme.useToken();
  const reduced = usePrefersReducedMotion();
  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="bottom"
      height="auto"
      title={title}
      {...reducedMotionSurface(reduced)}
      styles={{
        content: glassSurfaceStyle(token, 0.85),
        body: {
          padding: token.padding,
          paddingBottom: `calc(${token.padding}px + env(safe-area-inset-bottom))`,
        },
      }}
    >
      {children}
    </Drawer>
  );
};

/** Home's glass: light surfaces need more fill and a visible edge against the light backdrop. */
export const homeGlassAlpha = (token: ReturnType<typeof theme.useToken>['token']) =>
  isDarkTheme(token) ? 0.3 : 0.65;

/** Glass card every Home surface sits on. */
export const HomeCard: React.FC<{ children: React.ReactNode; padded?: boolean }> = ({
  children,
  padded,
}) => {
  const { token } = theme.useToken();
  return (
    <GlassPanel
      size="small"
      surfaceAlpha={homeGlassAlpha(token)}
      style={
        isDarkTheme(token)
          ? undefined
          : { border: `${token.lineWidth}px ${token.lineType} ${token.colorBorder}` }
      }
      styles={{ body: { padding: padded ? token.paddingSM : 0 } }}
    >
      {children}
    </GlassPanel>
  );
};

export const HomeSkeleton: React.FC<{ rows?: number }> = ({ rows = 3 }) => (
  <HomeCard padded>
    <Skeleton active title={false} paragraph={{ rows }} />
  </HomeCard>
);

export const HomeSectionError: React.FC<{ message: string; onRetry: () => void }> = ({
  message,
  onRetry,
}) => (
  <Alert
    type="error"
    showIcon
    title={message}
    action={
      <Button size="small" onClick={onRetry}>
        Try again
      </Button>
    }
  />
);

interface HomeSectionProps {
  id: string;
  title: string;
  /** Tooltip text; a newline starts a second line. */
  info?: string;
  /** Right-aligned header actions. */
  extra?: React.ReactNode;
  children: React.ReactNode;
}

export const HomeSection: React.FC<HomeSectionProps> = ({ id, title, info, extra, children }) => {
  const { token } = theme.useToken();
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      style={{ minWidth: 0, scrollMarginTop: token.marginLG }}
    >
      <Flex
        align="center"
        gap={token.marginXXS}
        wrap
        style={{ minHeight: token.controlHeight, marginBottom: token.marginXS }}
      >
        <Typography.Title id={`${id}-title`} level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {info && (
          <Tooltip title={info.split('\n').map((line) => <div key={line}>{line}</div>)}>
            <Button
              type="text"
              size="small"
              aria-label={info.replace('\n', ' ')}
              icon={<InfoCircleOutlined style={{ color: token.colorTextTertiary }} />}
            />
          </Tooltip>
        )}
        {extra && (
          <Flex align="center" gap={token.marginXXS} wrap style={{ marginInlineStart: 'auto' }}>
            {extra}
          </Flex>
        )}
      </Flex>
      {children}
    </section>
  );
};
