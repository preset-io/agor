import type { User } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { App as AntApp, theme as antdTheme, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StandaloneSettingsDrillProvider } from './SettingsDrill';
import { UserSettingsModal } from './UserSettingsModal';

const user = {
  user_id: 'layout-user',
  email: 'layout@example.test',
  name: 'Layout User',
  role: 'member',
  default_agentic_config: {},
} as User;

afterEach(cleanup);

describe('UserSettingsModal inside Settings (real browser)', () => {
  // Regression: the embedded editor always used the sider layout, whose content
  // pane antd sizes to width 0, so on a phone the fields collapsed to nothing.
  it('gives the panel fields a usable width at every viewport', async () => {
    render(
      <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
        <AntApp>
          <StandaloneSettingsDrillProvider section="users">
            <UserSettingsModal
              embedded
              open
              onClose={vi.fn()}
              user={user}
              currentUser={user}
              client={null}
              onUpdate={vi.fn()}
            />
          </StandaloneSettingsDrillProvider>
        </AntApp>
      </ConfigProvider>
    );

    const name = await screen.findByDisplayValue('Layout User');
    expect(name.getBoundingClientRect().width).toBeGreaterThan(window.innerWidth * 0.4);
    // The Settings shell owns Close; the editor adds none of its own.
    expect(screen.queryByRole('button', { name: 'Close user settings' })).toBeNull();
  });
});
