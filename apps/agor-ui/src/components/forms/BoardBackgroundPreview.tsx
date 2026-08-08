// biome-ignore-all lint/plugin/noHardcodedColorLiteral: translucent black/white scrims for the mini-preview overlay (zone outline, zone fill, label chip) sit on top of an arbitrary user gradient; no Ant token expresses a theme-neutral translucent scrim, so exact rgba() values are required here.

import { theme } from 'antd';
import { useId, useMemo } from 'react';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { buildScopedBoardCss } from '../../utils/sanitizeCss';
import { isDarkTheme } from '../../utils/theme';

export interface BoardBackgroundPreviewProps {
  /** Background value (solid color, gradient, or CSS background). */
  backgroundColor?: string | null;
  /** Extra scoped CSS (animations/keyframes). */
  customCss?: string | null;
  /** Height of the preview surface in px. */
  height?: number;
  /** Render representative mini cards + a zone so contrast is visible. */
  showContent?: boolean;
  /** Compact spacing/typography for gallery thumbnails. */
  variant?: 'full' | 'thumbnail';
  /** Optional aria-label for the preview surface. */
  ariaLabel?: string;
}

/**
 * Renders a miniature board surface using the EXACT same sanitize + scope
 * pipeline as the real canvas (SessionCanvas). This guarantees a faithful
 * impression of the background at scale — the same gradient, the same
 * sanitizer, the same reduced-motion handling — with representative mini
 * cards and a zone laid on top so readability is immediately visible.
 */
export function BoardBackgroundPreview({
  backgroundColor,
  customCss,
  height = 160,
  showContent = true,
  variant = 'full',
  ariaLabel,
}: BoardBackgroundPreviewProps) {
  const { token } = theme.useToken();
  const isDark = isDarkTheme(token);
  // useId gives a stable, unique scope per preview instance so multiple
  // thumbnails on screen never leak styles into one another.
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const scopeClass = `board-preview-${rawId}`;

  // Same sanitize + scope + reduced-motion pipeline as the canvas.
  const scopedCss = useMemo(
    () => buildScopedBoardCss({ backgroundColor, customCss, scopeClass }),
    [backgroundColor, customCss, scopeClass]
  );

  // When there is no explicit styling we render the trusted themed default
  // inline (never through the sanitizer), mirroring the canvas.
  const inlineBackground = scopedCss ? undefined : DEFAULT_BACKGROUNDS[isDark ? 'dark' : 'light'];

  const scale = variant === 'thumbnail' ? 0.85 : 1;

  return (
    <div
      className={scopeClass}
      role="img"
      aria-label={ariaLabel || 'Board background preview'}
      style={{
        position: 'relative',
        width: '100%',
        height,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
        border: `1px solid ${token.colorBorderSecondary}`,
        background: inlineBackground,
      }}
    >
      {/* String child (not dangerouslySetInnerHTML) — React sets it as text
          content, so sanitized CSS cannot terminate the <style> element. */}
      {scopedCss && <style>{scopedCss}</style>}
      {showContent && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            padding: 12 * scale,
            display: 'flex',
            gap: 10 * scale,
            alignItems: 'flex-start',
            pointerEvents: 'none',
          }}
        >
          {/* Mini zone */}
          <div
            style={{
              flex: '0 0 42%',
              height: `calc(100% - ${16 * scale}px)`,
              borderRadius: token.borderRadius,
              border: `1px dashed ${isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)'}`,
              background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
              padding: 8 * scale,
            }}
          >
            <MiniLabel text="Zone" token={token} isDark={isDark} scale={scale} muted />
          </div>
          {/* Mini cards */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 10 * scale,
            }}
          >
            <MiniCard
              token={token}
              scale={scale}
              accent={token.colorPrimary}
              title="Session card"
            />
            <MiniCard token={token} scale={scale} accent={token.colorSuccess} title="Branch card" />
          </div>
        </div>
      )}
    </div>
  );
}

interface TokenLike {
  colorBgElevated: string;
  colorBorder: string;
  colorBorderSecondary: string;
  colorText: string;
  colorTextSecondary: string;
  borderRadius: number;
  borderRadiusLG: number;
  colorPrimary: string;
  colorSuccess: string;
  boxShadowTertiary: string;
}

function MiniLabel({
  text,
  token,
  isDark,
  scale,
  muted,
}: {
  text: string;
  token: TokenLike;
  isDark: boolean;
  scale: number;
  muted?: boolean;
}) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 10 * scale,
        fontWeight: 600,
        letterSpacing: 0.3,
        padding: `${2 * scale}px ${6 * scale}px`,
        borderRadius: 4,
        color: muted ? token.colorTextSecondary : token.colorText,
        background: isDark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.6)',
      }}
    >
      {text}
    </span>
  );
}

function MiniCard({
  token,
  scale,
  accent,
  title,
}: {
  token: TokenLike;
  scale: number;
  accent: string;
  title: string;
}) {
  return (
    <div
      style={{
        borderRadius: token.borderRadius,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgElevated,
        boxShadow: token.boxShadowTertiary,
        padding: 8 * scale,
        display: 'flex',
        flexDirection: 'column',
        gap: 6 * scale,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 * scale }}>
        <span
          style={{
            width: 8 * scale,
            height: 8 * scale,
            borderRadius: '50%',
            background: accent,
            flex: '0 0 auto',
          }}
        />
        <span
          style={{
            fontSize: 10 * scale,
            fontWeight: 600,
            color: token.colorText,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </span>
      </div>
      <div
        style={{
          height: 4 * scale,
          width: '80%',
          borderRadius: 2,
          background: token.colorBorder,
        }}
      />
      <div
        style={{
          height: 4 * scale,
          width: '55%',
          borderRadius: 2,
          background: token.colorBorderSecondary,
        }}
      />
    </div>
  );
}
