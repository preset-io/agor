import type { Board } from '@agor-live/client';
import { HomeOutlined, SearchOutlined } from '@ant-design/icons';
import { Empty, Input, type InputRef, Modal, Typography, theme } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const { Text } = Typography;

/** Sentinel row id for the "Home" entry (no board). */
const HOME_ROW = '__home__';

interface PaletteRow {
  key: string;
  label: string;
  icon: React.ReactNode;
}

interface BoardSwitcherPaletteProps {
  open: boolean;
  boards: Board[];
  currentBoardId?: string | null;
  onClose: () => void;
  onSelectBoard: (boardId: string) => void;
  onSelectHome?: () => void;
}

/**
 * Keyboard-first board switcher. Opens on the `b` shortcut, filters as you
 * type, and navigates with ↑/↓ + Enter. Complements the click-driven
 * `BoardSwitcher` dropdown in the header rather than replacing it.
 */
export const BoardSwitcherPalette: React.FC<BoardSwitcherPaletteProps> = ({
  open,
  boards,
  currentBoardId,
  onClose,
  onSelectBoard,
  onSelectHome,
}) => {
  const { token } = theme.useToken();
  const inputRef = useRef<InputRef | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const rows = useMemo<PaletteRow[]>(() => {
    const boardRows: PaletteRow[] = boards
      .filter((b) => !b.archived)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((b) => ({ key: b.board_id, label: b.name, icon: b.icon || '📋' }));

    const withHome: PaletteRow[] = onSelectHome
      ? [{ key: HOME_ROW, label: 'Home', icon: <HomeOutlined /> }, ...boardRows]
      : boardRows;

    const q = filter.trim().toLowerCase();
    if (!q) return withHome;
    return withHome.filter((r) => r.label.toLowerCase().includes(q));
  }, [boards, filter, onSelectHome]);

  // Reset transient state each time the palette opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setFilter('');
    setSelectedIndex(0);
    // Defer focus until the modal's content is in the DOM.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Keep the cursor within the filtered list.
  useEffect(() => {
    setSelectedIndex((idx) => Math.min(idx, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  const selectRow = useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) return;
      if (row.key === HOME_ROW) onSelectHome?.();
      else onSelectBoard(row.key);
      onClose();
    },
    [onSelectBoard, onSelectHome, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => Math.min(idx + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => Math.max(idx - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectRow(rows[selectedIndex]);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={460}
      styles={{ body: { padding: 0 } }}
      style={{ top: 120 }}
      destroyOnHidden
    >
      <div style={{ padding: 12 }}>
        <Input
          ref={inputRef}
          size="large"
          placeholder="Switch board…"
          prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleKeyDown}
          variant="borderless"
          aria-label="Switch board"
        />
      </div>
      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }} />
      <div style={{ maxHeight: 360, overflowY: 'auto', padding: 8 }}>
        {rows.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No boards found" />
        ) : (
          rows.map((row, index) => {
            const isActive = index === selectedIndex;
            const isCurrent =
              row.key === currentBoardId || (row.key === HOME_ROW && !currentBoardId);
            return (
              <button
                type="button"
                key={row.key}
                onClick={() => selectRow(row)}
                onMouseMove={() => setSelectedIndex(index)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  border: 'none',
                  borderRadius: token.borderRadiusSM,
                  cursor: 'pointer',
                  background: isActive ? token.colorFillSecondary : 'transparent',
                  color: token.colorText,
                }}
              >
                <span style={{ fontSize: 16, display: 'inline-flex', width: 20 }}>{row.icon}</span>
                <Text strong={isCurrent}>{row.label}</Text>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
};

export default BoardSwitcherPalette;
