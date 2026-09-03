/**
 * Custom React Flow node components for board objects (text labels, zones, etc.)
 */

import type { BoardComment, BoardObject, User } from '@agor-live/client';
import {
  BgColorsOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  CommentOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  MoreOutlined,
  SettingOutlined,
  UnlockOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { Button, ColorPicker, Dropdown, Flex, Popover, Space, Typography, theme } from 'antd';
import type { Color } from 'antd/es/color-picker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NodeResizer, useViewport } from 'reactflow';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { getContrastingTextColor } from '../../../utils/theme';
import { getUserInitials } from '../../UserIdentityAvatar';
import { DeleteZoneModal } from './DeleteZoneModal';
import { ZoneConfigModal } from './ZoneConfigModal';
import type { LayerOp } from './zOrder';
import { toTranslucentZoneFill, ZONE_CONTENT_OPACITY } from './zoneAppearance';
import { effectiveLabelFontSize, statusFontSizeFor } from './zoneFontSize';

// Preserve the existing import surface for CommentsPanel and external callers.
export { ZONE_CONTENT_OPACITY } from './zoneAppearance';

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
  pinnedItemCount?: number;
  onUpdate?: (objectId: string, objectData: BoardObject) => void;
  onDelete?: (objectId: string, deleteAssociatedSessions: boolean) => void;
  onReorder?: (objectId: string, op: LayerOp) => void;
  /** Effective board.edit capability. Omitted only by isolated tests/fixtures. */
  canEdit?: boolean;
  /** Number of other zones whose rectangles intersect this zone. */
  overlappingZoneCount?: number;
  /** Whether each relative layer operation would change persisted order. */
  layerAvailability?: Record<LayerOp, boolean>;
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

const ZoneNodeComponent = ({ data, selected }: { data: ZoneNodeData; selected?: boolean }) => {
  const { token } = theme.useToken();
  const { zoom } = useViewport();
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [label, setLabel] = useState(data.label);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [recentColors, setRecentColors] = useState<string[]>(getRecentColors());
  const labelInputRef = useRef<HTMLInputElement>(null);
  const colors = getColorPalette(token);

  // Both connectivity and effective board.edit permission gate every zone
  // mutation. Production callers always provide canEdit; omission keeps old
  // isolated fixtures backwards compatible.
  const mutationGate = useMutationGate();
  const mutationDisabled = !mutationGate.canMutate || data.canEdit === false;

  // Inverse scale to keep toolbar at constant size regardless of zoom
  const scale = 1 / zoom;

  // Sync label state when data.label changes (from WebSocket or modal updates)
  useEffect(() => {
    setLabel(data.label);
  }, [data.label]);

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
      data.onUpdate(
        data.objectId,
        createObjectData({
          borderColor: hexColor,
          // A legacy `color` drove a translucent fill. Materialize that fill
          // before introducing borderColor, whose historical fallback is
          // opaque, so changing only the border has no surprise side effect.
          ...(data.color && !data.borderColor && !data.backgroundColor
            ? {
                backgroundColor: toTranslucentZoneFill(data.color, `${token.colorBgContainer}40`),
              }
            : {}),
        })
      );
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
  const handleReorder = (op: LayerOp) => {
    if (mutationDisabled) return;
    data.onReorder?.(data.objectId, op);
  };

  // Backwards compatibility: fall back to `color` if new fields not set
  const borderColor = data.borderColor || data.color || token.colorBorder;

  // Backwards compatibility: derive background from border if backgroundColor not set
  const backgroundColor =
    data.backgroundColor ||
    (data.borderColor
      ? data.borderColor // Use borderColor directly if set (supports alpha)
      : data.color
        ? toTranslucentZoneFill(data.color, `${token.colorBgContainer}40`)
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
        {selected && !mutationDisabled && (
          <div
            className="nodrag nopan"
            role="toolbar"
            aria-label="Zone actions"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              top: '-48px',
              left: '50%',
              transform: `translateX(-50%) scale(${scale})`,
              transformOrigin: 'center bottom',
              display: 'flex',
              alignItems: 'center',
              gap: token.marginXXS,
              padding: token.paddingXXS,
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadiusLG,
              boxShadow: token.boxShadowSecondary,
              zIndex: 1000,
              userSelect: 'none',
              whiteSpace: 'nowrap',
              pointerEvents: 'auto',
            }}
          >
            <Button
              type="text"
              size="small"
              aria-label="Rename zone"
              title="Rename zone"
              icon={<EditOutlined />}
              disabled={mutationDisabled}
              onClick={() => setIsEditingLabel(true)}
              style={{ width: 32, height: 32 }}
            />

            <Popover
              trigger="click"
              placement="bottom"
              title="Appearance"
              content={
                <Space orientation="vertical" size="middle" style={{ width: 240 }}>
                  <Flex justify="space-between" align="center" gap="middle">
                    <Typography.Text>Border</Typography.Text>
                    <ColorPicker
                      value={borderColor}
                      onChangeComplete={handleBorderColorChange}
                      trigger="click"
                      showText
                      format="hex"
                      presets={[
                        { label: 'Presets', colors },
                        ...(recentColors.length > 0
                          ? [{ label: 'Recent', colors: recentColors }]
                          : []),
                      ]}
                    >
                      <Button
                        aria-label="Zone border color"
                        icon={
                          <span
                            aria-hidden="true"
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: token.borderRadiusSM,
                              background: borderColor,
                              display: 'inline-block',
                            }}
                          />
                        }
                      >
                        {borderColor.toUpperCase()}
                      </Button>
                    </ColorPicker>
                  </Flex>
                  <Flex justify="space-between" align="center" gap="middle">
                    <Typography.Text>Fill</Typography.Text>
                    <ColorPicker
                      value={backgroundColor}
                      onChangeComplete={handleBackgroundColorChange}
                      trigger="click"
                      showText
                      format="hex"
                      presets={[
                        {
                          label: 'Presets',
                          colors: colors.map(
                            (color) =>
                              `${color}${Math.round(ZONE_CONTENT_OPACITY * 255)
                                .toString(16)
                                .padStart(2, '0')}`
                          ),
                        },
                        ...(recentColors.length > 0
                          ? [{ label: 'Recent', colors: recentColors }]
                          : []),
                      ]}
                    >
                      <Button
                        aria-label="Zone fill color"
                        icon={
                          <span
                            aria-hidden="true"
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: token.borderRadiusSM,
                              border: `1px solid ${token.colorBorder}`,
                              background: backgroundColor,
                              display: 'inline-block',
                            }}
                          />
                        }
                      >
                        {backgroundColor.toUpperCase()}
                      </Button>
                    </ColorPicker>
                  </Flex>
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                    Label size and theme defaults are in Zone settings.
                  </Typography.Text>
                </Space>
              }
            >
              <Button
                type="text"
                size="small"
                aria-label="Zone appearance"
                title="Zone appearance"
                disabled={mutationDisabled}
                icon={
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'relative',
                      display: 'inline-flex',
                      fontSize: token.fontSizeLG,
                    }}
                  >
                    <BgColorsOutlined />
                    <span
                      style={{
                        position: 'absolute',
                        right: -4,
                        bottom: -2,
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        border: `1px solid ${token.colorBorder}`,
                        background: backgroundColor,
                      }}
                    />
                  </span>
                }
                style={{ width: 32, height: 32 }}
              />
            </Popover>

            <Button
              type={data.locked ? 'default' : 'text'}
              size="small"
              aria-label={data.locked ? 'Unlock position and size' : 'Lock position and size'}
              title={data.locked ? 'Unlock position and size' : 'Lock position and size'}
              icon={data.locked ? <LockOutlined /> : <UnlockOutlined />}
              disabled={mutationDisabled}
              onClick={handleToggleLock}
              style={{
                width: 32,
                height: 32,
                ...(data.locked
                  ? { color: token.colorWarning, borderColor: token.colorWarning }
                  : {}),
              }}
            />

            <Button
              type="text"
              size="small"
              aria-label="Zone settings"
              title="Zone settings"
              icon={<SettingOutlined />}
              disabled={mutationDisabled}
              onClick={() => setConfigModalOpen(true)}
              style={{ width: 32, height: 32 }}
            />

            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: [
                  {
                    key: 'arrange',
                    label:
                      data.overlappingZoneCount && data.overlappingZoneCount > 0
                        ? `Arrange (${data.overlappingZoneCount} overlapping)`
                        : 'Arrange',
                    icon: <VerticalAlignTopOutlined />,
                    children: [
                      {
                        key: 'front',
                        label: 'Bring to front',
                        icon: <VerticalAlignTopOutlined />,
                        disabled: data.layerAvailability?.front === false,
                      },
                      {
                        key: 'forward',
                        label: 'Bring forward',
                        icon: <CaretUpOutlined />,
                        disabled: data.layerAvailability?.forward === false,
                      },
                      {
                        key: 'backward',
                        label: 'Send backward',
                        icon: <CaretDownOutlined />,
                        disabled: data.layerAvailability?.backward === false,
                      },
                      {
                        key: 'back',
                        label: 'Send to back',
                        icon: <VerticalAlignBottomOutlined />,
                        disabled: data.layerAvailability?.back === false,
                      },
                    ],
                  },
                  { type: 'divider' },
                  { key: 'delete', label: 'Delete zone', icon: <DeleteOutlined />, danger: true },
                ],
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (mutationDisabled) return;
                  if (key === 'delete') {
                    setDeleteModalOpen(true);
                    return;
                  }
                  if (
                    key === 'front' ||
                    key === 'forward' ||
                    key === 'backward' ||
                    key === 'back'
                  ) {
                    handleReorder(key);
                  }
                },
              }}
            >
              <Button
                type="text"
                size="small"
                aria-label="More zone actions"
                title="More zone actions"
                icon={<MoreOutlined />}
                disabled={mutationDisabled}
                style={{ width: 32, height: 32 }}
              />
            </Dropdown>
          </div>
        )}
        <div
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
          canEdit={data.canEdit !== false}
        />
      )}
      {deleteModalOpen && (
        <DeleteZoneModal
          open={deleteModalOpen}
          onCancel={() => setDeleteModalOpen(false)}
          onConfirm={() => {
            setDeleteModalOpen(false);
            if (data.onDelete) {
              data.onDelete(data.objectId, false);
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
