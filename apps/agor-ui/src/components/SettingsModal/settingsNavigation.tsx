import {
  AppstoreOutlined,
  BranchesOutlined,
  ClusterOutlined,
  ControlOutlined,
  CreditCardOutlined,
  ExperimentOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  RobotOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { SettingsSection } from '../../hooks/useSettingsRoute';

interface SettingsNavRow {
  section: SettingsSection;
  label: string;
  /** Label on the mobile index and drill-in header when it differs from `label`. */
  mobileLabel?: string;
  icon: React.ReactNode;
  beta?: boolean;
  /** Entity count shown on the mobile index. */
  count?: number;
}

interface SettingsNavGroup {
  key: string;
  title: string;
  /** Group heading on the mobile index when it differs from `title`. */
  mobileTitle?: string;
  /** Marker shown beside the group heading (e.g. the whole Cards group is Beta). */
  badge?: 'Beta' | 'Admin';
  rows: SettingsNavRow[];
}

type SettingsNavCounts = Partial<Record<SettingsSection, number>>;

interface BuildSettingsNavOptions {
  isAdmin: boolean;
  canSeeSection: (section: SettingsSection) => boolean;
  counts?: SettingsNavCounts;
}

/** Settings sections grouped as the caller's role may see them; the single source for every settings nav surface. */
export function buildSettingsNav({
  isAdmin,
  canSeeSection,
  counts = {},
}: BuildSettingsNavOptions): SettingsNavGroup[] {
  // People leads: who has access is the first thing an admin checks. MCP
  // servers are not a Settings section; they live in the MCP Marketplace.
  const groups: SettingsNavGroup[] = [
    {
      key: 'people',
      title: 'People',
      rows: [
        { section: 'users', label: 'Users', icon: <TeamOutlined /> },
        { section: 'groups', label: 'Groups', icon: <ClusterOutlined /> },
      ],
    },
    {
      key: 'resources',
      title: 'Resources',
      rows: [
        { section: 'boards', label: 'Boards', icon: <AppstoreOutlined /> },
        { section: 'repos', label: 'Repositories', icon: <FolderOutlined /> },
        { section: 'branches', label: 'Branches', icon: <BranchesOutlined /> },
        { section: 'teammates', label: 'Teammates', icon: <RobotOutlined /> },
        { section: 'artifacts', label: 'Artifacts', icon: <ExperimentOutlined /> },
        // Menu-only admin gate on top of canSeeSection.
        ...(isAdmin
          ? [
              {
                section: 'workspace-preferences' as const,
                label: 'Preferences',
                icon: <ControlOutlined />,
              },
            ]
          : []),
      ],
    },
    {
      key: 'cards',
      title: 'Cards',
      badge: 'Beta',
      rows: [
        { section: 'card-types', label: 'Card Types', icon: <CreditCardOutlined /> },
        { section: 'cards', label: 'All Cards', icon: <AppstoreOutlined /> },
      ],
    },
    {
      key: 'integrations',
      title: 'Integrations',
      badge: 'Admin',
      rows: [
        {
          section: 'agentic-tools',
          label: 'Agentic Tools',
          mobileLabel: 'Agentic tools',
          icon: <ThunderboltOutlined />,
        },
        {
          section: 'gateway',
          label: 'Gateway Channels',
          mobileLabel: 'Gateway channels',
          icon: <MessageOutlined />,
        },
      ],
    },
    {
      key: 'system',
      title: 'System',
      mobileTitle: 'About',
      rows: [
        {
          section: 'about',
          label: 'About',
          mobileLabel: 'About Agor',
          icon: <InfoCircleOutlined />,
        },
      ],
    },
  ];

  return groups
    .map((group) => ({
      ...group,
      rows: group.rows
        .filter((row) => canSeeSection(row.section))
        .map((row) => ({ ...row, count: counts[row.section] })),
    }))
    .filter((group) => group.rows.length > 0);
}

// Built once from the ungated nav, since a role-gated pane is still routable by URL.
const UNGATED_ROWS = buildSettingsNav({ isAdmin: true, canSeeSection: () => true }).flatMap(
  (group) => group.rows
);
const LABEL_BY_SECTION = new Map(UNGATED_ROWS.map((row) => [row.section, row.label] as const));
const MOBILE_LABEL_BY_SECTION = new Map(
  UNGATED_ROWS.map((row) => [row.section, row.mobileLabel ?? row.label] as const)
);

/** Desktop label for a section (e.g. the drill-in breadcrumb's first crumb). */
export function settingsSectionLabel(section: SettingsSection): string {
  return LABEL_BY_SECTION.get(section) ?? section;
}

/** Mobile drill-in header label for a section. */
export function settingsSectionMobileLabel(section: SettingsSection): string {
  return MOBILE_LABEL_BY_SECTION.get(section) ?? section;
}
