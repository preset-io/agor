/**
 * Custom React Flow node components for board objects (text labels, zones, etc.)
 */

import {
  normalizeZoneLayoutPolicy,
  setZoneLayoutMode,
  type ZoneContentJustification,
} from '@agor/core/layout/zone-layout';
import type { BoardComment, BoardObject, User } from '@agor-live/client';
import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  AppstoreOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  CommentOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  FontSizeOutlined,
  LockOutlined,
  MinusSquareOutlined,
  PlusSquareOutlined,
  SettingOutlined,
  SyncOutlined,
  UnlockOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignMiddleOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { ColorPicker, theme } from 'antd';
import type { Color } from 'antd/es/color-picker';
import { AggregationColor } from 'antd/es/color-picker/color';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NodeResizer, useStore, useViewport } from 'reactflow';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { getContrastingTextColor } from '../../../utils/theme';
import { getUserInitials } from '../../UserIdentityAvatar';
import { DeleteZoneModal } from './DeleteZoneModal';
import { ZoneConfigModal } from './ZoneConfigModal';
import type { LayerOp } from './zOrder';
import {
  clampZoneFontSize,
  effectiveLabelFontSize,
  statusFontSizeFor,
  ZONE_FONT_SIZE_MAX,
  ZONE_FONT_SIZE_MIN,
  ZONE_FONT_SIZE_STEP,
} from './zoneFontSize';

// Zone content opacity constant - used for zone background and color indicator
export const ZONE_CONTENT_OPACITY = 0.1;

const ZONE_TOOLBAR_VIEWPORT_PADDING = 16;

/** Keep a dynamically sized zone toolbar inside its canvas host. */
export function clampZoneToolbarCenter(
  requestedLeft: number,
  toolbarWidth: number,
  hostWidth: number
): number {
  const finiteHostWidth = Number.isFinite(hostWidth) && hostWidth > 0 ? hostWidth : 0;
  const finiteToolbarWidth = Number.isFinite(toolbarWidth) && toolbarWidth > 0 ? toolbarWidth : 0;
  const finiteRequestedLeft = Number.isFinite(requestedLeft) ? requestedLeft : finiteHostWidth / 2;
  if (finiteHostWidth <= 0) return finiteRequestedLeft;
  const halfWidth = Math.min(
    finiteToolbarWidth / 2,
    Math.max(0, finiteHostWidth - ZONE_TOOLBAR_VIEWPORT_PADDING * 2) / 2
  );
  const minLeft = ZONE_TOOLBAR_VIEWPORT_PADDING + halfWidth;
  const maxLeft = Math.max(minLeft, finiteHostWidth - ZONE_TOOLBAR_VIEWPORT_PADDING - halfWidth);
  return Math.min(Math.max(finiteRequestedLeft, minLeft), maxLeft);
}

/**
 * Get color palette from Ant Design preset colors
 * Uses the -6 variants (primary saturation) from the color scale
 */
const getColorPalette = (token: ReturnType<typeof theme.useToken>['token']) => [
  token.colorBorder, // gray (neutral default)
  token.red6 || token.red, // red-6
  token.orange6 || token.orange, // orange-6
  token.green6 || token.green, // green-6
  token.blue6 || token.blue, // blue-6
  token.purple6 || token.purple, // purple-6
  token.magenta6 || token.magenta, // magenta-6
];

type ZoneBoardObject = Extract<BoardObject, { type: 'zone' }>;

/**
 * ZoneNode - Resizable rectangle for organizing sessions visually
 */
interface ZoneNodeData extends Omit<ZoneBoardObject, 'type'> {
  objectId: string;
  boardZoneLayoutDefaults?: ZoneBoardObject['layout'];
  /** The shared multi-selection toolbar replaces this zone's individual controls. */
  suppressToolbar?: boolean;
  pinnedItemCount?: number;
  /** Every measured board node currently contained by this zone. */
  positionableItemCount?: number;
  /** Pinned entities whose rendered surface owns a real density state. */
  densityExpandableItemCount?: number;
  /** Density-capable pinned entities that are currently collapsed. */
  compactDensityExpandableItemCount?: number;
  onUpdate?: (
    objectId: string,
    objectData: BoardObject
  ) => boolean | undefined | Promise<boolean | undefined>;
  onDelete?: (objectId: string, deleteAssociatedSessions: boolean) => void;
  onReorder?: (objectId: string, op: LayerOp) => void;
  onArrangeContents?: (objectId: string) => void;
  onJustifyContents?: (objectId: string, justification: ZoneContentJustification) => void;
  onSetContentsCompact?: (objectId: string, compact: boolean) => void;
}

// Local storage key for recent colors
const RECENT_COLORS_KEY = 'agor-zone-recent-colors';

// Helper to get recent colors from localStorage
const getRecentColors = (): string[] => {
  try {
    const saved = localStorage.getItem(RECENT_COLORS_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
};

// Helper to save a color to recent colors
const saveRecentColor = (color: string) => {
  try {
    const recent = getRecentColors();
    // Remove duplicate if exists
    const filtered = recent.filter((c) => c.toLowerCase() !== color.toLowerCase());
    // Add to front, limit to 12 recent colors
    const updated = [color, ...filtered].slice(0, 12);
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(updated));
  } catch (error) {
    console.warn('Failed to save recent color:', error);
  }
};

const ZoneNodeComponent = ({
  data,
  selected,
  xPos,
  yPos,
}: {
  data: ZoneNodeData;
  selected?: boolean;
  xPos?: number;
  yPos?: number;
}) => {
  const { token } = theme.useToken();
  const { x: viewportX, y: viewportY, zoom } = useViewport();
  const reactFlowRoot = useStore((state) => state.domNode);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [label, setLabel] = useState(data.label);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [layoutActionsExpanded, setLayoutActionsExpanded] = useState(false);
  const [toolbarBounds, setToolbarBounds] = useState({ toolbarWidth: 0, hostWidth: 0 });
  const [recentColors, setRecentColors] = useState<string[]>(getRecentColors());
  const labelInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const colors = getColorPalette(token);

  // Connection gate: when disconnected / reconnecting / out-of-sync, every
  // mutator inside the zone (resize, label edit, color, lock, config, delete)
  // short-circuits. The toolbar is still rendered for read-only signal but
  // its controls visually dim and silently no-op on click.
  const mutationGate = useMutationGate();
  const mutationDisabled = !mutationGate.canMutate;

  // A zone reads as collapsed only when every density-capable item is. A partially
  // collapsed zone still offers "Collapse contents", so one click makes the
  // whole zone uniform instead of toggling it into a different mixed state.
  const zoneContentsAllCompact =
    (data.densityExpandableItemCount ?? 0) > 0 &&
    (data.compactDensityExpandableItemCount ?? 0) >= (data.densityExpandableItemCount ?? 0);
  const autoZoneEnabled = normalizeZoneLayoutPolicy(data.layout).mode === 'auto';
  const positionableItemCount = data.positionableItemCount ?? data.pinnedItemCount ?? 0;
  const hasExtraLayoutActions =
    positionableItemCount > 0 || (data.densityExpandableItemCount ?? 0) > 0;
  const layoutActionsId = `zone-layout-actions-${data.objectId}`;

  // Inverse scale keeps zone labels at a legible size regardless of zoom.
  const finiteZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const finiteViewportX = Number.isFinite(viewportX) ? viewportX : 0;
  const finiteViewportY = Number.isFinite(viewportY) ? viewportY : 0;
  const finiteNodeX = Number.isFinite(xPos)
    ? (xPos as number)
    : Number.isFinite(data.x)
      ? data.x
      : 0;
  const finiteNodeY = Number.isFinite(yPos)
    ? (yPos as number)
    : Number.isFinite(data.y)
      ? data.y
      : 0;
  const finiteNodeWidth = Number.isFinite(data.width) && data.width > 0 ? data.width : 0;
  const scale = 1 / finiteZoom;
  const toolbarHost = reactFlowRoot ?? (typeof document === 'undefined' ? null : document.body);
  const toolbarLeft =
    finiteViewportX + finiteNodeX * finiteZoom + (finiteNodeWidth * finiteZoom) / 2;
  const toolbarTop = finiteViewportY + finiteNodeY * finiteZoom - 8;
  const clampedToolbarLeft = clampZoneToolbarCenter(
    toolbarLeft,
    toolbarBounds.toolbarWidth,
    toolbarBounds.hostWidth
  );

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || typeof window === 'undefined') return;

    const measure = () => {
      const next = {
        toolbarWidth: toolbar.getBoundingClientRect().width,
        hostWidth: reactFlowRoot?.clientWidth ?? window.innerWidth,
      };
      setToolbarBounds((current) =>
        current.toolbarWidth === next.toolbarWidth && current.hostWidth === next.hostWidth
          ? current
          : next
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    if (reactFlowRoot) observer.observe(reactFlowRoot);
    return () => observer.disconnect();
  }, [reactFlowRoot]);

  // Sync label state when data.label changes (from WebSocket or modal updates)
  useEffect(() => {
    setLabel(data.label);
  }, [data.label]);

  // Sync toolbar visibility with selected state
  useEffect(() => {
    if (selected) {
      setToolbarVisible(true);
    } else {
      setLayoutActionsExpanded(false);
      // Delay hiding to prevent flicker during re-renders
      const timer = setTimeout(() => setToolbarVisible(false), 100);
      return () => clearTimeout(timer);
    }
  }, [selected]);

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (isEditingLabel && labelInputRef.current) {
      labelInputRef.current.focus();
      labelInputRef.current.select();
    }
  }, [isEditingLabel]);

  const zoneData = useMemo<ZoneBoardObject>(
    () => ({
      type: 'zone',
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
      label: data.label,
      borderColor: data.borderColor,
      backgroundColor: data.backgroundColor,
      color: data.color,
      status: data.status,
      locked: data.locked,
      fontSize: data.fontSize,
      zIndex: data.zIndex,
      trigger: data.trigger,
      layout: data.layout,
      layout_binding: data.layout_binding,
    }),
    [
      data.x,
      data.y,
      data.width,
      data.height,
      data.label,
      data.borderColor,
      data.backgroundColor,
      data.color,
      data.status,
      data.locked,
      data.fontSize,
      data.zIndex,
      data.trigger,
      data.layout,
      data.layout_binding,
    ]
  );

  // Helper to create full object data with current values
  const createObjectData = (overrides: Partial<Omit<ZoneBoardObject, 'type'>>): BoardObject => ({
    ...zoneData,
    ...overrides,
  });

  const handleSaveLabel = () => {
    setIsEditingLabel(false);
    if (mutationDisabled) return;
    if (label !== data.label && data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ label }));
    }
  };

  const handleToggleAutoZone = () => {
    if (mutationDisabled || !data.onUpdate) return;
    void data.onUpdate(
      data.objectId,
      createObjectData({
        layout: setZoneLayoutMode(data.layout, autoZoneEnabled ? 'manual' : 'auto'),
        layout_binding: 'override',
      })
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSaveLabel();
    } else if (e.key === 'Escape') {
      setLabel(data.label); // Reset to original
      setIsEditingLabel(false);
    }
  };

  const handleBorderColorChange = (color: Color) => {
    if (mutationDisabled) return;
    const hexColor = color.toHexString();
    if (data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ borderColor: hexColor }));
    }
    // Save to recent colors and update state
    saveRecentColor(hexColor);
    setRecentColors(getRecentColors());
  };

  const handleBackgroundColorChange = (color: Color) => {
    if (mutationDisabled) return;
    const hexColor = color.toHexString();
    if (data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ backgroundColor: hexColor }));
    }
    // Save to recent colors and update state
    saveRecentColor(hexColor);
    setRecentColors(getRecentColors());
  };

  const handleToggleLock = () => {
    if (mutationDisabled) return;
    if (data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ locked: !data.locked }));
    }
  };

  // Effective label font size: sanitized persisted value or the theme default.
  // Sanitizing on read defends the DOM against bad fontSize data (negative,
  // non-finite, absurdly large) written via MCP/import.
  const labelFontSize = effectiveLabelFontSize(data.fontSize, token.fontSize);
  // Status keeps its smaller relative size, scaled from the label size when set.
  const statusFontSize = statusFontSizeFor(data.fontSize, token.fontSize, token.fontSizeSM);
  const atMinFontSize = labelFontSize <= ZONE_FONT_SIZE_MIN;
  const atMaxFontSize = labelFontSize >= ZONE_FONT_SIZE_MAX;

  const handleFontSizeStep = (delta: number) => {
    if (mutationDisabled) return;
    const next = clampZoneFontSize(labelFontSize, delta);
    if (next !== labelFontSize && data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ fontSize: next }));
    }
  };

  const handleReorder = (op: LayerOp) => {
    if (mutationDisabled) return;
    data.onReorder?.(data.objectId, op);
  };

  // Shared style for the compact square icon buttons in the toolbar.
  const iconButtonStyle: React.CSSProperties = {
    width: '20px',
    height: '20px',
    borderRadius: '3px',
    backgroundColor: token.colorBgContainer,
    // Keep every border component longhand because active buttons update only
    // the color. Mixing `border` with a conditional `borderColor` makes React
    // warn while removing the active state during rerender.
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: token.colorBorder,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
    cursor: 'pointer',
    padding: 0,
    color: token.colorText,
    flexShrink: 0,
  };

  const verticalDivider = (
    <div
      style={{
        width: '1px',
        height: '24px',
        backgroundColor: token.colorBorder,
        margin: '0 2px',
        alignSelf: 'center',
        flexShrink: 0,
      }}
    />
  );

  // A toolbar icon button that runs `action` on pointer-up (matching the
  // existing lock/settings/delete buttons' event handling). Pointer-up covers
  // both mouse and touch (a tap synthesizes a click, but we never act on click).
  // Keyboard activation is driven EXPLICITLY from onKeyDown (Enter/Space) — we
  // deliberately do NOT infer keyboard from a `detail === 0` click, because some
  // touch engines also report detail === 0 for tap-synthesized clicks, which
  // would double-fire (pointerUp + click). onClick only swallows propagation.
  const renderActionButton = (
    key: string,
    title: string,
    icon: React.ReactNode,
    action: () => void,
    disabled = false,
    options: {
      pressed?: boolean;
      active?: boolean;
      expanded?: boolean;
      controls?: string;
    } = {}
  ) => (
    <button
      key={key}
      type="button"
      aria-label={title}
      aria-pressed={options.pressed}
      aria-expanded={options.expanded}
      aria-controls={options.controls}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (mutationDisabled || disabled) return;
        action();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (mutationDisabled || disabled) return;
        action();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{
        ...iconButtonStyle,
        ...(options.active
          ? {
              backgroundColor: token.colorPrimaryBg,
              borderColor: token.colorPrimary,
              color: token.colorPrimary,
            }
          : {}),
        ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
      }}
      title={title}
    >
      {icon}
    </button>
  );

  const layerIconStyle: React.CSSProperties = {
    fontSize: '12px',
    color: token.colorText,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  // Backwards compatibility: fall back to `color` if new fields not set
  const borderColor = data.borderColor || data.color || token.colorBorder;

  // Helper to convert color to rgba with custom alpha (for backwards compatibility with old `color` field)
  const colorToRgba = (colorStr: string, alpha: number): string => {
    try {
      const color = new AggregationColor(colorStr);
      const rgb = color.toRgb();
      // If the color already has alpha, multiply it with the requested alpha
      const finalAlpha = rgb.a * alpha;
      // biome-ignore lint/plugin/noHardcodedColorLiteral: persisted user color resolver emits CSS syntax from parsed channels
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${finalAlpha})`;
    } catch {
      // Fallback to token if parsing fails
      return `${token.colorBgContainer}40`;
    }
  };

  // Backwards compatibility: derive background from border if backgroundColor not set
  const backgroundColor =
    data.backgroundColor ||
    (data.borderColor
      ? data.borderColor // Use borderColor directly if set (supports alpha)
      : data.color
        ? colorToRgba(data.color, ZONE_CONTENT_OPACITY) // Old behavior for backwards compat
        : `${token.colorBgContainer}40`);

  const getTextColor = (background: string): string => getContrastingTextColor(background, token);

  const textColor = getTextColor(backgroundColor);

  return (
    <>
      <NodeResizer
        isVisible={selected && !data.locked && !mutationDisabled}
        minWidth={200}
        minHeight={200}
        handleStyle={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          backgroundColor: borderColor,
        }}
        lineStyle={{
          borderColor: borderColor,
        }}
      />
      <div
        style={{
          width: '100%',
          height: '100%',
          border: `2px solid ${borderColor}`,
          borderRadius: token.borderRadiusLG,
          background: backgroundColor,
          padding: token.padding,
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'none', // Let sessions behind zone be clickable
          zIndex: -1, // Zones always behind sessions
          backdropFilter: 'blur(4px)',
          position: 'relative',
        }}
      >
        {/* Toolbar - ALWAYS rendered, visibility controlled by CSS only */}
        {toolbarHost &&
          createPortal(
            /* biome-ignore format: keep the established toolbar body stable inside its portal */
            <div
          ref={toolbarRef}
          className="nodrag nopan"
          role="toolbar"
          aria-label="Zone actions"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          style={{
            // A portal at the React Flow root escapes every node stacking
            // context. It therefore stays above zones, cards, artifacts, and
            // comments without raising the translucent zone container itself.
            position: reactFlowRoot ? 'absolute' : 'fixed',
            top: toolbarTop,
            left: clampedToolbarLeft,
            // Anchor the toolbar's bottom edge above the zone. The established
            // zone controls stay in one row; lower-frequency layout controls
            // expand horizontally from their disclosure instead of wrapping.
            transform: 'translate(-50%, -100%)',
            transformOrigin: 'center bottom',
            display: data.suppressToolbar ? 'none' : 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'nowrap',
            gap: '8px',
            width: 'max-content',
            maxWidth: reactFlowRoot ? 'calc(100% - 32px)' : 'calc(100vw - 32px)',
            overflowX: 'auto',
            overflowY: 'hidden',
            padding: '6px',
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadius,
            boxShadow: token.boxShadowSecondary,
            zIndex: 10_000,
            userSelect: 'none',
            // CSS-only visibility control (no DOM changes). When the
            // connection gate is closed we also dim and block clicks so the
            // toolbar reads as read-only and never accidentally fires.
            opacity: toolbarVisible ? (mutationDisabled ? 0.5 : 1) : 0,
            pointerEvents: toolbarVisible && !mutationDisabled ? 'auto' : 'none',
            transition: 'opacity 0.15s ease',
          }}
        >
          {/* Border Color Picker */}
          <div
            className="nodrag nopan"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
          >
            <span
              style={{
                fontSize: '11px',
                color: token.colorTextSecondary,
                fontWeight: 500,
                userSelect: 'none',
                lineHeight: 1,
              }}
            >
              Border
            </span>
            <ColorPicker
              value={borderColor}
              onChange={handleBorderColorChange}
              trigger="click"
              destroyTooltipOnHide
              showText={false}
              format="hex"
              presets={[
                {
                  label: 'Presets',
                  colors: colors,
                },
                ...(recentColors.length > 0
                  ? [
                      {
                        label: 'Recent',
                        colors: recentColors,
                      },
                    ]
                  : []),
              ]}
            >
              <button
                type="button"
                style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '3px',
                  backgroundColor: borderColor,
                  border: `1px solid ${token.colorBorder}`,
                  userSelect: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  boxShadow: token.boxShadowSecondary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="Change border color"
              />
            </ColorPicker>
          </div>
          <div
            style={{
              width: '1px',
              height: '24px',
              backgroundColor: token.colorBorder,
              margin: '0 2px',
              alignSelf: 'center',
            }}
          />
          {/* Background Color Picker */}
          <div
            className="nodrag nopan"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
          >
            <span
              style={{
                fontSize: '11px',
                color: token.colorTextSecondary,
                fontWeight: 500,
                userSelect: 'none',
                lineHeight: 1,
              }}
            >
              Background
            </span>
            <ColorPicker
              value={backgroundColor}
              onChange={handleBackgroundColorChange}
              trigger="click"
              destroyTooltipOnHide
              showText={false}
              format="hex"
              presets={[
                {
                  label: 'Presets',
                  colors: colors.map(
                    (c) =>
                      `${c}${Math.round(ZONE_CONTENT_OPACITY * 255)
                        .toString(16)
                        .padStart(2, '0')}`
                  ),
                },
                ...(recentColors.length > 0
                  ? [
                      {
                        label: 'Recent',
                        colors: recentColors,
                      },
                    ]
                  : []),
              ]}
            >
              <button
                type="button"
                style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '3px',
                  backgroundColor: backgroundColor,
                  border: `1px solid ${token.colorBorder}`,
                  userSelect: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  boxShadow: token.boxShadowSecondary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="Change background color"
              />
            </ColorPicker>
          </div>
          <div
            style={{
              width: '1px',
              height: '24px',
              backgroundColor: token.colorBorder,
              margin: '0 2px',
              alignSelf: 'center',
            }}
          />
          {/* Lock/Unlock Button */}
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (mutationDisabled) return;
              handleToggleLock();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '3px',
              backgroundColor: data.locked ? token.colorWarningBg : token.colorBgContainer,
              border: `1px solid ${data.locked ? token.colorWarning : token.colorBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              userSelect: 'none',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
            title={data.locked ? 'Unlock zone' : 'Lock zone'}
          >
            {data.locked ? (
              <LockOutlined
                style={{
                  fontSize: '12px',
                  color: token.colorWarning,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              />
            ) : (
              <UnlockOutlined
                style={{
                  fontSize: '12px',
                  color: token.colorText,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              />
            )}
          </button>
          {verticalDivider}
          <fieldset
            className="nodrag nopan"
            aria-label="Zone layout actions"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              minWidth: 0,
              margin: 0,
              padding: 0,
              border: 0,
              flexShrink: 0,
            }}
          >
            {renderActionButton(
              'auto-zone',
              autoZoneEnabled ? 'Disable Auto Zone' : 'Enable Auto Zone',
              <SyncOutlined
                style={{
                  ...layerIconStyle,
                  color: autoZoneEnabled ? token.colorPrimary : token.colorText,
                }}
              />,
              handleToggleAutoZone,
              false,
              { pressed: autoZoneEnabled, active: autoZoneEnabled }
            )}
            {renderActionButton(
              'arrange-contents',
              'Tidy up contents',
              <AppstoreOutlined style={layerIconStyle} />,
              () => data.onArrangeContents?.(data.objectId),
              positionableItemCount < 1
            )}
            {hasExtraLayoutActions &&
              renderActionButton(
                'more-layout-actions',
                layoutActionsExpanded ? 'Hide extra layout actions' : 'Show more layout actions',
                <EllipsisOutlined style={layerIconStyle} />,
                () => setLayoutActionsExpanded((expanded) => !expanded),
                false,
                {
                  active: layoutActionsExpanded,
                  expanded: layoutActionsExpanded,
                  controls: layoutActionsId,
                }
              )}
            {layoutActionsExpanded && hasExtraLayoutActions && (
              <div
                id={layoutActionsId}
                style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
              >
                <fieldset
                  className="nodrag nopan"
                  aria-label="Justify contents"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    minWidth: 0,
                    margin: 0,
                    padding: 0,
                    border: 0,
                  }}
                >
                  {renderActionButton(
                    'justify-left',
                    'Justify contents left',
                    <AlignLeftOutlined style={layerIconStyle} />,
                    () => data.onJustifyContents?.(data.objectId, 'left'),
                    positionableItemCount < 1
                  )}
                  {renderActionButton(
                    'justify-middle',
                    'Center in zone',
                    <AlignCenterOutlined style={layerIconStyle} />,
                    () => data.onJustifyContents?.(data.objectId, 'middle'),
                    positionableItemCount < 1
                  )}
                  {renderActionButton(
                    'justify-right',
                    'Justify contents right',
                    <AlignRightOutlined style={layerIconStyle} />,
                    () => data.onJustifyContents?.(data.objectId, 'right'),
                    positionableItemCount < 1
                  )}
                  {renderActionButton(
                    'justify-top',
                    'Justify contents top',
                    <VerticalAlignTopOutlined style={layerIconStyle} />,
                    () => data.onJustifyContents?.(data.objectId, 'top'),
                    positionableItemCount < 1
                  )}
                  {renderActionButton(
                    'justify-vertical-middle',
                    'Center contents vertically',
                    <VerticalAlignMiddleOutlined style={layerIconStyle} />,
                    () => data.onJustifyContents?.(data.objectId, 'vertical_middle'),
                    positionableItemCount < 1
                  )}
                  {renderActionButton(
                    'justify-bottom',
                    'Justify contents bottom',
                    <VerticalAlignBottomOutlined style={layerIconStyle} />,
                    () => data.onJustifyContents?.(data.objectId, 'bottom'),
                    positionableItemCount < 1
                  )}
                </fieldset>
                {/*
                  One derived-state density button rather than a Collapse/Expand
                  pair: a zone whose items are all collapsed can only usefully be
                  expanded, and vice versa, so a second slot would always be a no-op.
                */}
                {(data.densityExpandableItemCount ?? 0) > 0 &&
                  renderActionButton(
                    'set-contents-compact',
                    zoneContentsAllCompact ? 'Expand contents' : 'Collapse contents',
                    zoneContentsAllCompact ? (
                      <PlusSquareOutlined style={layerIconStyle} />
                    ) : (
                      <MinusSquareOutlined style={layerIconStyle} />
                    ),
                    () => data.onSetContentsCompact?.(data.objectId, !zoneContentsAllCompact)
                  )}
              </div>
            )}
          </fieldset>
          {verticalDivider}
          {/* Layer (z-order) controls */}
          <div
            className="nodrag nopan"
            style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
          >
            {renderActionButton(
              'to-back',
              'Send to back',
              <VerticalAlignBottomOutlined style={layerIconStyle} />,
              () => handleReorder('back')
            )}
            {renderActionButton(
              'send-backward',
              'Send backward',
              <CaretDownOutlined style={layerIconStyle} />,
              () => handleReorder('backward')
            )}
            {renderActionButton(
              'bring-forward',
              'Bring forward',
              <CaretUpOutlined style={layerIconStyle} />,
              () => handleReorder('forward')
            )}
            {renderActionButton(
              'to-front',
              'Bring to front',
              <VerticalAlignTopOutlined style={layerIconStyle} />,
              () => handleReorder('front')
            )}
          </div>
          {verticalDivider}
          {/* Label font-size stepper */}
          <div
            className="nodrag nopan"
            style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
          >
            <FontSizeOutlined
              style={{ fontSize: '12px', color: token.colorTextSecondary }}
              title="Label font size"
            />
            {renderActionButton(
              'font-smaller',
              'Smaller label',
              <span style={{ fontSize: '13px', lineHeight: 1, fontWeight: 600 }}>−</span>,
              () => handleFontSizeStep(-ZONE_FONT_SIZE_STEP),
              atMinFontSize
            )}
            <span
              style={{
                fontSize: '11px',
                color: token.colorTextSecondary,
                fontVariantNumeric: 'tabular-nums',
                minWidth: '20px',
                textAlign: 'center',
                userSelect: 'none',
              }}
            >
              {Math.round(labelFontSize)}
            </span>
            {renderActionButton(
              'font-larger',
              'Larger label',
              <span style={{ fontSize: '13px', lineHeight: 1, fontWeight: 600 }}>+</span>,
              () => handleFontSizeStep(ZONE_FONT_SIZE_STEP),
              atMaxFontSize
            )}
          </div>
          {verticalDivider}
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (mutationDisabled) return;
              setConfigModalOpen(true);
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '3px',
              backgroundColor: token.colorBgContainer,
              border: `1px solid ${token.colorBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              userSelect: 'none',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
            title="Configure zone"
          >
            <SettingOutlined
              style={{
                fontSize: '12px',
                color: token.colorText,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          </button>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (mutationDisabled) return;
              setDeleteModalOpen(true);
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = token.colorError;
              e.currentTarget.style.borderColor = token.colorError;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = token.colorTextSecondary;
              e.currentTarget.style.borderColor = token.colorBorder;
            }}
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '3px',
              backgroundColor: token.colorBgContainer,
              border: `1px solid ${token.colorBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              userSelect: 'none',
              cursor: 'pointer',
              padding: 0,
              color: token.colorTextSecondary,
              flexShrink: 0,
            }}
            title="Delete zone"
          >
            <DeleteOutlined
              style={{
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          </button>
        </div>,
            toolbarHost
          )}
        <div
          data-zone-marquee-ignore="true"
          style={{
            pointerEvents: 'auto',
            // Position label to allow for inverse scaling
            position: 'relative',
            width: '100%',
            // Reserve space for scaled label (font size / zoom)
            minHeight: `${labelFontSize * scale}px`,
          }}
          onDoubleClick={() => {
            if (mutationDisabled) return;
            setIsEditingLabel(true);
          }}
        >
          {isEditingLabel ? (
            <input
              ref={labelInputRef}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={handleSaveLabel}
              onKeyDown={handleKeyDown}
              className="nodrag" // Prevent node drag when typing
              style={{
                margin: 0,
                fontSize: labelFontSize,
                fontWeight: 600,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: textColor,
                padding: 0,
                width: '100%',
                // Apply inverse scale to maintain constant visual size during editing
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            />
          ) : (
            <h3
              style={{
                margin: 0,
                fontSize: labelFontSize,
                fontWeight: 600,
                color: textColor,
                // Apply inverse scale to maintain constant visual size (Figma-style)
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                // Constrain to zone width accounting for padding and scale
                maxWidth: `${(data.width - token.padding * 2) / scale}px`,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </h3>
          )}
        </div>
        {data.status && (
          <div
            style={{
              marginTop: `${8 * scale}px`,
              fontSize: statusFontSize,
              fontWeight: 500,
              color: textColor,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              // Apply inverse scale to maintain constant visual size
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              // Constrain to zone width accounting for padding and scale
              maxWidth: `${(data.width - token.padding * 2) / scale}px`,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.status}
          </div>
        )}
      </div>
      {configModalOpen && (
        <ZoneConfigModal
          open={configModalOpen}
          onCancel={() => setConfigModalOpen(false)}
          zoneName={data.label}
          objectId={data.objectId}
          onUpdate={data.onUpdate || (() => {})}
          zoneData={zoneData}
          boardZoneLayoutDefaults={data.boardZoneLayoutDefaults}
        />
      )}
      {deleteModalOpen && (
        <DeleteZoneModal
          open={deleteModalOpen}
          onCancel={() => setDeleteModalOpen(false)}
          onConfirm={(deleteAssociatedSessions) => {
            setDeleteModalOpen(false);
            if (data.onDelete) {
              data.onDelete(data.objectId, deleteAssociatedSessions);
            }
          }}
          zoneName={data.label}
          pinnedItemCount={data.pinnedItemCount || 0}
        />
      )}
    </>
  );
};

// Memoize to prevent unnecessary re-renders
export const ZoneNode = React.memo(ZoneNodeComponent);

/**
 * CommentNode - Spatial comment bubble pinned to canvas
 */
interface CommentNodeData {
  comment: BoardComment;
  replyCount: number;
  user?: User;
  parentLabel?: string; // Label of parent zone/branch if pinned
  parentColor?: string; // Color of parent zone if pinned
  onClick?: (commentId: string) => void;
  onHover?: (commentId: string) => void;
  onLeave?: () => void;
}

// Pin dimensions and positioning constants
const PIN_WIDTH = 36;
const PIN_HEIGHT = 48;
const PIN_CIRCULAR_SIZE = 36; // Size of the circular top part
const PIN_OFFSET_X = -PIN_WIDTH / 2; // Center horizontally
const PIN_OFFSET_Y = -PIN_HEIGHT; // Position tip at coordinate

const CommentNodeComponent = ({ data }: { data: CommentNodeData }) => {
  const { token } = theme.useToken();
  const { zoom } = useViewport();
  const { comment, replyCount, user, parentLabel, parentColor, onClick, onHover, onLeave } = data;
  const [isHovered, setIsHovered] = useState(false);

  // Show first line of content as preview
  const preview = comment.content.split('\n')[0].slice(0, 80);
  const hasMore = comment.content.length > 80 || comment.content.includes('\n');

  const pinColor = comment.resolved ? token.colorSuccess : token.colorPrimary;
  const totalCount = 1 + replyCount; // Thread root + replies

  // Inverse scale to keep pin at constant size regardless of zoom
  const scale = 1 / zoom;

  return (
    <div
      onClick={() => onClick?.(comment.comment_id)}
      onMouseEnter={() => {
        setIsHovered(true);
        onHover?.(comment.comment_id);
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        onLeave?.();
      }}
      style={{
        position: 'relative',
        cursor: 'grab',
        // Combine scale with translate to offset pin tip to anchor point
        transform: `scale(${scale}) translate(${PIN_OFFSET_X}px, ${PIN_OFFSET_Y}px)`,
        transformOrigin: 'top left',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Pin shape - teardrop/location pin */}
      <div
        style={{
          position: 'relative',
          width: `${PIN_WIDTH}px`,
          height: `${PIN_HEIGHT}px`,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
        }}
      >
        {/* Circular top part with backdrop */}
        <div
          style={{
            width: `${PIN_CIRCULAR_SIZE}px`,
            height: `${PIN_CIRCULAR_SIZE}px`,
            borderRadius: '50% 50% 50% 0',
            // Layered background: subtle backdrop + color overlay at 50%
            background: `
              linear-gradient(${pinColor}80, ${pinColor}80),
              ${token.colorBgLayout}33
            `,
            border: `2px solid ${token.colorBgContainer}`,
            boxShadow: isHovered ? token.boxShadow : token.boxShadowSecondary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            transform: `rotate(-45deg) ${isHovered ? 'scale(1.1)' : 'scale(1)'}`,
            fontSize: '18px',
            position: 'absolute',
            top: '0',
            left: '0',
          }}
        >
          {/* Author identity (counter-rotate to keep upright) */}
          <div style={{ transform: 'rotate(45deg)' }}>
            {user ? getUserInitials(user) : <CommentOutlined />}
          </div>
        </div>

        {/* Reply count badge */}
        {totalCount > 1 && (
          <div
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              minWidth: '20px',
              height: '20px',
              borderRadius: '10px',
              background: `${token.colorPrimary}bf`,
              border: `2px solid ${token.colorBgContainer}`,
              color: token.colorBgContainer,
              fontSize: '11px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 4px',
              zIndex: 1,
            }}
          >
            {totalCount}
          </div>
        )}

        {/* Zone color indicator */}
        {parentColor && (
          <div
            style={{
              position: 'absolute',
              top: '-6px',
              left: '-6px',
              width: '14px',
              height: '14px',
              // Fill with zone color at ZONE_CONTENT_OPACITY
              backgroundColor: `${parentColor}${Math.round(ZONE_CONTENT_OPACITY * 255)
                .toString(16)
                .padStart(2, '0')}`,
              // Border is solid zone color
              border: `2px solid ${parentColor}`,
              borderRadius: '3px',
              zIndex: 1,
              boxShadow: token.boxShadowSecondary,
            }}
          />
        )}
      </div>

      {/* Hover tooltip - simple who/when/what preview */}
      {isHovered && (
        <div
          style={{
            position: 'absolute',
            left: '40px',
            top: '0',
            minWidth: '240px',
            maxWidth: '320px',
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadiusLG,
            padding: '12px',
            boxShadow: token.boxShadow,
            zIndex: 1000,
            pointerEvents: 'none',
          }}
        >
          {/* Who and when */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 14 }}>{user ? getUserInitials(user) : <CommentOutlined />}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: token.colorText,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {user?.name || 'Anonymous'}
              </div>
              <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                {new Date(comment.created_at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </div>
            </div>
          </div>

          {/* Where - parent object if pinned */}
          {parentLabel && (
            <div
              style={{
                fontSize: 11,
                color: token.colorTextSecondary,
                marginBottom: 8,
                padding: '4px 8px',
                background: token.colorBgContainer,
                borderRadius: token.borderRadiusSM,
              }}
            >
              {parentLabel}
            </div>
          )}

          {/* What - content preview */}
          <div
            style={{
              fontSize: 13,
              color: token.colorText,
              lineHeight: '1.5',
              wordBreak: 'break-word',
            }}
          >
            {preview}
            {hasMore && <span style={{ color: token.colorTextSecondary }}>...</span>}
          </div>
        </div>
      )}
    </div>
  );
};

export const CommentNode = React.memo(CommentNodeComponent);
