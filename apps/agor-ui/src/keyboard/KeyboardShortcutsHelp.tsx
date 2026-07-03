import { Modal, Typography, theme } from 'antd';
import type React from 'react';
import { Fragment, useMemo } from 'react';
import { formatCombo } from './matchShortcut';
import { SHORTCUTS } from './shortcuts';
import type { ShortcutDefinition, ShortcutGroup } from './types';

const { Text } = Typography;

// Render order for the grouped sections.
const GROUP_ORDER: ShortcutGroup[] = ['General', 'Navigation', 'Actions'];

const KeyCap: React.FC<{ label: string }> = ({ label }) => {
  const { token } = theme.useToken();
  return (
    <kbd
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 22,
        height: 22,
        padding: '0 6px',
        fontFamily: token.fontFamilyCode,
        fontSize: 12,
        lineHeight: 1,
        color: token.colorText,
        background: token.colorFillTertiary,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusSM,
        boxShadow: `0 1px 0 ${token.colorBorderSecondary}`,
      }}
    >
      {label}
    </kbd>
  );
};

/** Renders the first combo of a shortcut as a row of key caps. */
const Combo: React.FC<{ combo: string }> = ({ combo }) => {
  const labels = useMemo(() => formatCombo(combo), [combo]);
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {labels.map((label) => (
        // Labels within a single combo are unique (a combo never repeats a key).
        <KeyCap key={label} label={label} />
      ))}
    </span>
  );
};

interface KeyboardShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Discoverable help overlay listing every registered shortcut. Generated
 * entirely from the `SHORTCUTS` registry so it can never fall out of sync with
 * what the keyboard system actually handles.
 */
export const KeyboardShortcutsHelp: React.FC<KeyboardShortcutsHelpProps> = ({ open, onClose }) => {
  const { token } = theme.useToken();

  const grouped = useMemo(() => {
    const map = new Map<ShortcutGroup, ShortcutDefinition[]>();
    for (const shortcut of SHORTCUTS) {
      const list = map.get(shortcut.group) ?? [];
      list.push(shortcut);
      map.set(shortcut.group, list);
    }
    return GROUP_ORDER.filter((group) => map.has(group)).map((group) => ({
      group,
      items: map.get(group) ?? [],
    }));
  }, []);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="Keyboard shortcuts"
      width={480}
      centered
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 8 }}>
        {grouped.map(({ group, items }) => (
          <div key={group}>
            <Text
              type="secondary"
              style={{
                textTransform: 'uppercase',
                fontSize: 11,
                letterSpacing: 0.5,
                fontWeight: 600,
              }}
            >
              {group}
            </Text>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column' }}>
              {items.map((shortcut) => (
                <div
                  key={shortcut.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 0',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <Text>{shortcut.description}</Text>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {shortcut.keys.map((combo, i) => (
                      <Fragment key={combo}>
                        {i > 0 && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            or
                          </Text>
                        )}
                        <Combo combo={combo} />
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
};
