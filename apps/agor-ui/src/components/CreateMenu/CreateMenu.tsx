import {
  AppstoreOutlined,
  BranchesOutlined,
  FolderOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Dropdown } from 'antd';

/** The four focused creation flows, reached from one shared menu. */
export type CreateModalKind = 'teammate' | 'branch' | 'board' | 'repository';

export interface CreateMenuItem {
  key: CreateModalKind;
  label: string;
  icon: React.ReactNode;
}

/**
 * Single source of truth for the "New" menu items (label + icon + order).
 * Reused by the desktop dropdown and the mobile "More" accordion so they can't
 * drift.
 */
export const CREATE_MENU_ITEMS: CreateMenuItem[] = [
  { key: 'teammate', label: 'New AI teammate', icon: <RobotOutlined /> },
  { key: 'branch', label: 'New branch', icon: <BranchesOutlined /> },
  { key: 'board', label: 'New board', icon: <AppstoreOutlined /> },
  { key: 'repository', label: 'New repository', icon: <FolderOutlined /> },
];

const MENU_ITEMS: MenuProps['items'] = CREATE_MENU_ITEMS.map(({ key, label, icon }) => ({
  key,
  label,
  icon,
}));

export interface CreateMenuProps {
  /** Fired with the picked flow; the host opens the matching modal directly. */
  onSelect: (kind: CreateModalKind) => void;
  disabled?: boolean;
  /** The trigger element (button/pill/circle). */
  children: React.ReactNode;
}

/**
 * Shared dropdown behind every "New" entry point (homepage header + board).
 * Owns the menu items so both surfaces stay identical; hosts supply their own
 * trigger via `children`.
 */
export const CreateMenu: React.FC<CreateMenuProps> = ({ onSelect, disabled, children }) => (
  <Dropdown
    disabled={disabled}
    menu={{
      items: MENU_ITEMS,
      onClick: ({ key }) => onSelect(key as CreateModalKind),
    }}
    trigger={['click']}
  >
    {children}
  </Dropdown>
);
