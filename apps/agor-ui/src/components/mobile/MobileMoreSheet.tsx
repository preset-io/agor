import type { Board, BoardComment, Branch, Session } from '@agor-live/client';
import {
  BgColorsOutlined,
  BulbOutlined,
  DesktopOutlined,
  EditOutlined,
  MoonOutlined,
} from '@ant-design/icons';
import { Button, Drawer, Flex, Segmented, Typography, theme } from 'antd';
import { useState } from 'react';
import { type ThemeMode, useTheme } from '../../contexts/ThemeContext';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { glassSurfaceStyle } from '../GlassSurface/glassStyles';
import { ThemeEditorModal } from '../ThemeEditorModal/ThemeEditorModal';
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
 * (light/dark/system/custom) control on top that matches the desktop theme
 * menu and reuses the shared ThemeEditorModal. Opened from the tab bar's More
 * destination.
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
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);

  return (
    <>
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
          vertical
          gap={token.marginXS}
          style={{ padding: `${token.paddingSM}px ${token.padding}px` }}
        >
          <Flex align="center" justify="space-between" gap={token.margin}>
            <Typography.Text strong>Appearance</Typography.Text>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              style={{ paddingInline: 0 }}
              onClick={() => setThemeEditorOpen(true)}
            >
              Edit theme
            </Button>
          </Flex>
          <Segmented
            block
            value={themeMode}
            onChange={(value) => setThemeMode(value as ThemeMode)}
            options={[
              { value: 'light', label: 'Light', icon: <BulbOutlined /> },
              { value: 'dark', label: 'Dark', icon: <MoonOutlined /> },
              { value: 'system', label: 'System', icon: <DesktopOutlined /> },
              { value: 'custom', label: 'Custom', icon: <BgColorsOutlined /> },
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
      <ThemeEditorModal open={themeEditorOpen} onClose={() => setThemeEditorOpen(false)} />
    </>
  );
};
