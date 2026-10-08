import {
  AppstoreOutlined,
  BranchesOutlined,
  FolderOutlined,
  RobotOutlined,
} from '@ant-design/icons';

/** CreateDialog tabs as menu rows, shared by Home's New menu and the mobile More sheet. */
const CREATE_MENU_ITEMS = [
  { key: 'teammate', label: 'Teammate', icon: <RobotOutlined /> },
  { key: 'branch', label: 'Branch', icon: <BranchesOutlined /> },
  { key: 'board', label: 'Board', icon: <AppstoreOutlined /> },
  { key: 'repository', label: 'Repository', icon: <FolderOutlined /> },
] as const;

export type CreateTab = (typeof CREATE_MENU_ITEMS)[number]['key'];

export const createMenuItems = (isAdmin: boolean) =>
  CREATE_MENU_ITEMS.filter((item) => isAdmin || item.key !== 'repository');
