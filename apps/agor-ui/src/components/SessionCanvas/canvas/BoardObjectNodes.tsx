/**
 * Custom React Flow node components for board objects (text labels, zones, etc.)
 */

import type { BoardComment, BoardObject } from '@agor/core/types';
import { DeleteOutlined, LockOutlined, SettingOutlined, UnlockOutlined } from '@ant-design/icons';
import { ColorPicker, theme } from 'antd';
import type { Color } from 'antd/es/color-picker';
import { AggregationColor } from 'antd/es/color-picker/color';
import React, { useEffect, useRef, useState } from 'react';
import { NodeResizer, useViewport } from 'reactflow';
import { DeleteZoneModal } from './DeleteZoneModal';
import { ZoneConfigModal } from './ZoneConfigModal';

// Zone content opacity constant - used for zone background and color indicator
export const ZONE_CONTENT_OPACITY = 0.1;

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

/**
 * ZoneNode - Resizable rectangle for organizing sessions visually
 */
interface ZoneNodeData {
  objectId: string;
  label: string;
  width: number;
  height: number;
  borderColor?: string;
  backgroundColor?: string;
  /** @deprecated Use borderColor instead */
  color?: string;
  status?: string;
  locked?: boolean;
  x: number;
  y: number;
  trigger?: BoardObject extends { type: 'zone'; trigger?: infer T } ? T : never;
  sessionCount?: number;
  onUpdate?: (objectId: string, objectData: BoardObject) => void;
  onDelete?: (objectId: string, deleteAssociatedSessions: boolean) => void;
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
    const filtered = recent.filter(c => c.toLowerCase() !== color.toLowerCase());
    // Add to front, limit to 12 recent colors
    const updated = [color, ...filtered].slice(0, 12);
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(updated));
  } catch (error) {
    console.warn('Failed to save recent color:', error);
  }
};

const ZoneNodeComponent = ({ data, selected }: { data: ZoneNodeData; selected?: boolean }) => {
  const { token } = theme.useToken();
  const { zoom } = useViewport();
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [label, setLabel] = useState(data.label);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(false);
  const [recentColors, setRecentColors] = useState<string[]>(getRecentColors());
  const labelInputRef = useRef<HTMLInputElement>(null);
  const colors = getColorPalette(token);

  // Inverse scale to keep toolbar at constant size regardless of zoom
  const scale = 1 / zoom;

  // Sync label state when data.label changes (from WebSocket or modal updates)
  useEffect(() => {
    setLabel(data.label);
  }, [data.label]);

  // Sync toolbar visibility with selected state
  useEffect(() => {
    if (selected) {
      setToolbarVisible(true);
    } else {
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

  // Helper to create full object data with current values
  const createObjectData = (
    overrides: Partial<{
      width: number;
      height: number;
      label: string;
      borderColor?: string;
      backgroundColor?: string;
      color?: string;
      status?: string;
      locked?: boolean;
      trigger?: BoardObject extends { type: 'zone'; trigger?: infer T } ? T : never;
    }>
  ): BoardObject => ({
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
    trigger: data.trigger,
    ...overrides,
  });

  const handleSaveLabel = () => {
    setIsEditingLabel(false);
    if (label !== data.label && data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ label }));
    }
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
    const hexColor = color.toHexString();
    if (data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ borderColor: hexColor }));
    }
    // Save to recent colors and update state
    saveRecentColor(hexColor);
    setRecentColors(getRecentColors());
  };

  const handleBackgroundColorChange = (color: Color) => {
    const hexColor = color.toHexString();
    if (data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ backgroundColor: hexColor }));
    }
    // Save to recent colors and update state
    saveRecentColor(hexColor);
    setRecentColors(getRecentColors());
  };

  const handleToggleLock = () => {
    if (data.onUpdate) {
      data.onUpdate(data.objectId, createObjectData({ locked: !data.locked }));
    }
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

  // Calculate text color based on background color luminance for readability
  const getTextColor = (bgColor: string): string => {
    try {
      // Use Ant Design's Color class to parse any color format
      const color = new AggregationColor(bgColor);
      const rgb = color.toRgb();

      // For very transparent backgrounds, use theme text color (text will be over board background)
      if (rgb.a < 0.3) {
        return token.colorText;
      }

      // Calculate relative luminance (WCAG formula)
      const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;

      // Use white text for dark backgrounds, black for light backgrounds
      return luminance > 0.5 ? '#000000' : '#ffffff';
    } catch {
      // Fallback to theme text for invalid colors
      return token.colorText;
    }
  };

  const textColor = getTextColor(backgroundColor);

  return (
    <>
      <NodeResizer
        isVisible={selected && !data.locked}
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
        <div
          className="nodrag nopan"
          onPointerDown={e => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerUp={e => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
          }}
          style={{
            position: 'absolute',
            top: '-44px',
            left: '50%',
            transform: `translateX(-50%) scale(${scale})`,
            transformOrigin: 'center bottom',
            display: 'flex',
            gap: '8px',
            padding: '6px',
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadius,
            boxShadow: token.boxShadowSecondary,
            zIndex: 1000,
            userSelect: 'none',
            // CSS-only visibility control (no DOM changes)
            opacity: toolbarVisible ? 1 : 0,
            pointerEvents: toolbarVisible ? 'auto' : 'none',
            transition: 'opacity 0.15s ease',
          }}
        >
          {/* Border Color Picker */}
          <div
            className="nodrag nopan"
            onPointerDown={e => {
              e.stopPropagation();
            }}
            onPointerUp={e => {
              e.stopPropagation();
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <span
              style={{
                fontSize: '11px',
                color: token.colorTextSecondary,
                fontWeight: 500,
                userSelect: 'none',
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
                  width: '24px',
                  height: '24px',
                  borderRadius: '4px',
                  backgroundColor: borderColor,
                  border: `2px solid ${token.colorBorder}`,
                  userSelect: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  boxShadow: token.boxShadowSecondary,
                }}
                title="Change border color"
              />
            </ColorPicker>
          </div>
          <div
            style={{
              width: '1px',
              height: '20px',
              backgroundColor: token.colorBorder,
              margin: '0 2px',
            }}
          />
          {/* Background Color Picker */}
          <div
            className="nodrag nopan"
            onPointerDown={e => {
              e.stopPropagation();
            }}
            onPointerUp={e => {
              e.stopPropagation();
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <span
              style={{
                fontSize: '11px',
                color: token.colorTextSecondary,
                fontWeight: 500,
                userSelect: 'none',
              }}
            >
              Fill
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
                    c =>
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
                  width: '24px',
                  height: '24px',
                  borderRadius: '4px',
                  backgroundColor: backgroundColor,
                  border: `2px solid ${token.colorBorder}`,
                  userSelect: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  boxShadow: token.boxShadowSecondary,
                }}
                title="Change background color"
              />
            </ColorPicker>
          </div>
          <div
            style={{
              width: '1px',
              height: '20px',
              backgroundColor: token.colorBorder,
              margin: '0 2px',
            }}
          />
          {/* Lock/Unlock Button */}
          <button
            type="button"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerUp={e => {
              e.preventDefault();
              e.stopPropagation();
              handleToggleLock();
            }}
            onClick={e => {
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
            }}
            title={data.locked ? 'Unlock zone' : 'Lock zone'}
          >
            {data.locked ? (
              <LockOutlined style={{ fontSize: '12px', color: token.colorWarning }} />
            ) : (
              <UnlockOutlined style={{ fontSize: '12px', color: token.colorText }} />
            )}
          </button>
          <div
            style={{
              width: '1px',
              height: '20px',
              backgroundColor: token.colorBorder,
              margin: '0 2px',
            }}
          />
          <button
            type="button"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerUp={e => {
              e.preventDefault();
              e.stopPropagation();
              setConfigModalOpen(true);
            }}
            onClick={e => {
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
            }}
            title="Configure zone"
          >
            <SettingOutlined style={{ fontSize: '12px', color: token.colorText }} />
          </button>
          <button
            type="button"
            onPointerDown={e => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerUp={e => {
              e.preventDefault();
              e.stopPropagation();
              setDeleteModalOpen(true);
            }}
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = token.colorError;
              e.currentTarget.style.borderColor = token.colorError;
            }}
            onMouseLeave={e => {
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
            }}
            title="Delete zone"
          >
            <DeleteOutlined style={{ fontSize: '12px' }} />
          </button>
        </div>
        <div
          style={{
            pointerEvents: 'auto',
          }}
          onDoubleClick={() => setIsEditingLabel(true)}
        >
          {isEditingLabel ? (
            <input
              ref={labelInputRef}
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              onBlur={handleSaveLabel}
              onKeyDown={handleKeyDown}
              className="nodrag" // Prevent node drag when typing
              style={{
                margin: 0,
                fontSize: '24px',
                fontWeight: 600,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: textColor,
                padding: 0,
                width: '100%',
              }}
            />
          ) : (
            <h3
              style={{
                margin: 0,
                fontSize: '24px',
                fontWeight: 600,
                color: textColor,
              }}
            >
              {label}
            </h3>
          )}
        </div>
        {data.status && (
          <div
            style={{
              marginTop: '8px',
              fontSize: '12px',
              fontWeight: 500,
              color: textColor,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {data.status}
          </div>
        )}
      </div>
      <ZoneConfigModal
        open={configModalOpen}
        onCancel={() => setConfigModalOpen(false)}
        zoneName={data.label}
        objectId={data.objectId}
        onUpdate={data.onUpdate || (() => {})}
        zoneData={createObjectData({})}
      />
      <DeleteZoneModal
        open={deleteModalOpen}
        onCancel={() => setDeleteModalOpen(false)}
        onConfirm={deleteAssociatedSessions => {
          setDeleteModalOpen(false);
          if (data.onDelete) {
            data.onDelete(data.objectId, deleteAssociatedSessions);
          }
        }}
        zoneName={data.label}
        sessionCount={data.sessionCount || 0}
      />
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
  user?: import('@agor/core/types').User;
  parentLabel?: string; // Label of parent zone/worktree if pinned
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
          {/* Emoji (counter-rotate to keep upright) */}
          <div style={{ transform: 'rotate(45deg)' }}>{user?.emoji || '💬'}</div>
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
            <div style={{ fontSize: 14 }}>{user?.emoji || '💬'}</div>
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
