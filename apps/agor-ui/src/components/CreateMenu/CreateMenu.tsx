import {
  AppstoreOutlined,
  BranchesOutlined,
  FolderOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Dropdown } from 'antd';

/** The four focused creation flows, reached from one shared menu. */
export type CreateModalKind = 'teammate' | 'branch' | 'board' | 'repository';

export interface CreateMenuItem {
  key: CreateModalKind;
  label: string;
  icon: React.ReactNode;
}

/**
 * Single source of truth for the create menu items (label + icon + order).
 * Reused by the navbar dropdown and the mobile "Create new" row so they can't
 * drift. Repository is admin-only; use `createMenuItems` to apply that rule.
 */
export const CREATE_MENU_ITEMS: CreateMenuItem[] = [
  { key: 'teammate', label: 'Teammate', icon: <RobotOutlined /> },
  { key: 'branch', label: 'Branch', icon: <BranchesOutlined /> },
  { key: 'board', label: 'Board', icon: <AppstoreOutlined /> },
  { key: 'repository', label: 'Repository', icon: <FolderOutlined /> },
];

export const createMenuItems = (isAdmin: boolean): CreateMenuItem[] =>
  isAdmin ? CREATE_MENU_ITEMS : CREATE_MENU_ITEMS.filter((item) => item.key !== 'repository');

export interface CreateMenuProps {
  /** Fired with the picked flow; the host opens the matching modal directly. */
  onSelect: (kind: CreateModalKind) => void;
  /** Shows the admin-only Repository item. */
  isAdmin: boolean;
  disabled?: boolean;
  /** The trigger element. */
  children: React.ReactNode;
}

/**
 * Shared dropdown behind the navbar "+". Owns the menu items; the
 * host supplies the trigger via `children`.
 */
export const CreateMenu: React.FC<CreateMenuProps> = ({
  onSelect,
  isAdmin,
  disabled,
  children,
}) => (
  <Dropdown
    disabled={disabled}
    menu={{
      items: createMenuItems(isAdmin).map(({ key, label, icon }) => ({ key, label, icon })),
      onClick: ({ key }) => onSelect(key as CreateModalKind),
    }}
    trigger={['click']}
  >
    {children}
  </Dropdown>
);
