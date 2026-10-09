import type { User } from '@agor-live/client';
import {
  BulbOutlined,
  CommentOutlined,
  DownOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  LogoutOutlined,
  MoonOutlined,
  PlusOutlined,
  ReadOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Badge, Drawer, List, Segmented, Typography, theme } from 'antd';
import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { resolveExternalAppLink } from '../../utils/externalAppLink';
import { type CreateModalKind, createMenuItems } from '../CreateMenu';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { MobileListRow } from './MobileListRow';

interface MobileMoreSheetProps {
  open: boolean;
  onClose: () => void;
  user?: User | null;
  /** Unread comments and mentions for the caller. */
  commentsBadge: number;
  onOpenComments: () => void;
  /** Opens the shared create flow for the picked kind (sheet closes first). Omit to hide the row. */
  onCreate?: (kind: CreateModalKind) => void;
  /** Shows the admin-only Repository create item. */
  isAdmin: boolean;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenUserSettings: () => void;
  onLogout?: () => void;
  externalAppLink?: string;
  externalAppLabel?: string;
}

/** "More" bottom sheet: account, create, search, comments, knowledge, settings, appearance, docs, sign out. */
export const MobileMoreSheet: React.FC<MobileMoreSheetProps> = ({
  open,
  onClose,
  user,
  commentsBadge,
  onOpenComments,
  onCreate,
  isAdmin,
  onOpenWorkspaceSettings,
  onOpenUserSettings,
  onLogout,
  externalAppLink,
  externalAppLabel,
}) => {
  const { token } = theme.useToken();
  const { themeMode, setThemeMode } = useTheme();
  const reduced = usePrefersReducedMotion();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const externalApp = resolveExternalAppLink(externalAppLink, externalAppLabel);
  const userName = user?.name || user?.email || 'Profile';

  const close = () => {
    setCreateOpen(false);
    onClose();
  };
  // Leaving the sheet open would keep its mask above the next surface.
  const go = (action: () => void) => () => {
    close();
    action();
  };
  const icon = (node: React.ReactNode) => (
    <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeLG }}>{node}</span>
  );
  const row = (title: string, avatar: React.ReactNode, onPress: () => void) => (
    <MobileListRow inset title={title} ariaLabel={title} avatar={icon(avatar)} onPress={onPress} />
  );

  return (
    <Drawer
      open={open}
      onClose={close}
      destroyOnHidden
      placement="bottom"
      height="auto"
      title="More"
      {...reducedMotionSurface(reduced)}
      styles={{
        content: glassSurfaceStyle(token, 0.85),
        body: { padding: 0, paddingBottom: 'env(safe-area-inset-bottom)' },
      }}
    >
      <List split={false}>
        <MobileListRow
          inset
          title={userName}
          ariaLabel={`Profile: ${userName}`}
          avatar={<UserIdentityAvatar user={user} size={token.controlHeightSM} />}
          onPress={go(onOpenUserSettings)}
        />
        {onCreate && (
          <MobileListRow
            inset
            title="Create new"
            ariaLabel="Create new"
            avatar={icon(<PlusOutlined />)}
            expanded={createOpen}
            onPress={() => setCreateOpen((value) => !value)}
            trailing={<DownOutlined rotate={createOpen ? 180 : 0} />}
          />
        )}
        {onCreate && createOpen && (
          <div style={{ paddingInlineStart: token.paddingLG }}>
            {createMenuItems(isAdmin).map((item) => (
              <Fragment key={item.key}>
                {row(
                  item.label,
                  item.icon,
                  go(() => onCreate(item.key))
                )}
              </Fragment>
            ))}
          </div>
        )}
        {row(
          'Search',
          <SearchOutlined />,
          go(() => navigate('/m/search'))
        )}
        <MobileListRow
          inset
          title="Comments and mentions"
          ariaLabel={
            commentsBadge > 0
              ? `Comments and mentions, ${commentsBadge} unread`
              : 'Comments and mentions'
          }
          avatar={icon(<CommentOutlined />)}
          trailing={<Badge count={commentsBadge} />}
          onPress={go(onOpenComments)}
        />
        {row(
          'Knowledge base',
          <ReadOutlined />,
          go(() => navigate('/knowledge'))
        )}
        {row(
          'Settings',
          <SettingOutlined />,
          go(() => onOpenWorkspaceSettings('boards'))
        )}
        {externalApp &&
          row(
            externalApp.label,
            <ExportOutlined />,
            go(() => window.open(externalApp.href, '_blank', 'noopener,noreferrer'))
          )}
        <List.Item style={{ paddingInline: token.padding, minHeight: MOBILE_TOUCH_TARGET }}>
          <Typography.Text>Appearance</Typography.Text>
          <Segmented
            aria-label="Appearance"
            value={themeMode === 'light' ? 'light' : 'dark'}
            onChange={(value) => setThemeMode(value === 'light' ? 'light' : 'dark')}
            options={[
              { value: 'light', label: 'Light', icon: <BulbOutlined /> },
              { value: 'dark', label: 'Dark', icon: <MoonOutlined /> },
            ]}
          />
        </List.Item>
        {row(
          'Documentation',
          <InfoCircleOutlined />,
          go(() =>
            window.open('https://agor.live/guide/getting-started', '_blank', 'noopener,noreferrer')
          )
        )}
        {onLogout && (
          <MobileListRow
            inset
            danger
            title="Sign out"
            ariaLabel="Sign out"
            avatar={
              <LogoutOutlined style={{ color: token.colorError, fontSize: token.fontSizeLG }} />
            }
            onPress={go(onLogout)}
          />
        )}
      </List>
    </Drawer>
  );
};
