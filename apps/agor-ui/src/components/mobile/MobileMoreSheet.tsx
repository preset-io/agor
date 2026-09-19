import type { Board, BoardComment, Branch, Session } from '@agor-live/client';
import { BulbOutlined, MoonOutlined } from '@ant-design/icons';
import { Drawer, Flex, Segmented, Typography, theme } from 'antd';
import { useTheme } from '../../contexts/ThemeContext';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import { MobileNavTree } from './MobileNavTree';

interface MobileMoreSheetProps {
  open: boolean;
  onClose: () => void;
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  sessionsByBranch: Map<string, Session[]>;
  commentById: Map<string, BoardComment>;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenUserSettings: () => void;
  onLogout?: () => void;
}

/**
 * "More" bottom sheet: board switcher + Knowledge base + Settings (incl. MCP
 * servers) + account/sign out via the reused nav tree, with an Appearance
 * (light/dark) control on top. Opened from the tab bar's More destination.
 */
export const MobileMoreSheet: React.FC<MobileMoreSheetProps> = ({
  open,
  onClose,
  boardById,
  branchById,
  sessionsByBranch,
  commentById,
  onOpenWorkspaceSettings,
  onOpenUserSettings,
  onLogout,
}) => {
  const { token } = theme.useToken();
  const { themeMode, setThemeMode } = useTheme();
  const reduced = usePrefersReducedMotion();

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="bottom"
      height="80%"
      title="More"
      {...reducedMotionSurface(reduced)}
      styles={{
        content: glassSurfaceStyle(token, 0.85),
        body: { padding: 0, paddingBottom: 'env(safe-area-inset-bottom)' },
      }}
    >
      <Flex
        align="center"
        justify="space-between"
        gap={token.margin}
        style={{ padding: `${token.paddingSM}px ${token.padding}px` }}
      >
        <Typography.Text strong>Appearance</Typography.Text>
        <Segmented
          value={themeMode === 'light' ? 'light' : 'dark'}
          onChange={(value) => setThemeMode(value === 'light' ? 'light' : 'dark')}
          options={[
            { value: 'light', label: 'Light', icon: <BulbOutlined /> },
            { value: 'dark', label: 'Dark', icon: <MoonOutlined /> },
          ]}
        />
      </Flex>
      <MobileNavTree
        boardById={boardById}
        branchById={branchById}
        sessionsByBranch={sessionsByBranch}
        commentById={commentById}
        onNavigate={onClose}
        onOpenWorkspaceSettings={(section) => {
          onClose();
          onOpenWorkspaceSettings(section);
        }}
        onOpenUserSettings={() => {
          onClose();
          onOpenUserSettings();
        }}
        onLogout={onLogout}
      />
    </Drawer>
  );
};
