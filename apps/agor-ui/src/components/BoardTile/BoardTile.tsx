import type { Board, Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { AppstoreOutlined } from '@ant-design/icons';
import { theme } from 'antd';
import type { CSSProperties } from 'react';

/**
 * A board's face is its primary assistant's emoji — boards no longer carry
 * their own icon. Resolves `primary_teammate_id → branch → teammate emoji`
 * from the already-loaded branch map; returns undefined when the board has no
 * primary teammate (or it isn't loaded), so callers render the neutral glyph.
 */
export function getBoardEmoji(
  board: Pick<Board, 'primary_teammate_id'>,
  branchById?: Map<string, Branch> | null
): string | undefined {
  const teammateId = board.primary_teammate_id;
  if (!teammateId || !branchById) return undefined;
  const branch = branchById.get(teammateId);
  return branch ? getTeammateConfig(branch)?.emoji || undefined : undefined;
}

export interface BoardTileProps {
  /** Pre-resolved primary-assistant emoji (see {@link getBoardEmoji}). */
  emoji?: string;
  size?: number;
  style?: CSSProperties;
}

/**
 * Renders a board's face on a rounded square. The square shape is deliberate:
 * it keeps boards visually distinct from the circular user avatars so a board
 * is never mistaken for a person.
 */
export const BoardTile: React.FC<BoardTileProps> = ({ emoji, size = 36, style }) => {
  const { token } = theme.useToken();
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.56),
        lineHeight: 1,
        flexShrink: 0,
        ...style,
      }}
    >
      {emoji ?? (
        <AppstoreOutlined
          style={{ fontSize: Math.round(size * 0.5), color: token.colorTextSecondary }}
        />
      )}
    </div>
  );
};
