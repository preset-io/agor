import { render } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import type { SettingsSection } from '../../hooks/useSettingsRoute';
import { StandaloneSettingsDrillProvider } from './SettingsDrill';

/**
 * Wrapper that mirrors the Workspace Settings shell for tests:
 * `StandaloneSettingsDrillProvider` owns the drill/controller state and renders
 * the same controller-driven Save/Cancel footer the real shell renders, so a
 * table's drill-in create/edit flow is exercisable end-to-end (open action →
 * form in place → footer Save/Cancel).
 */
/**
 * Render `ui` inside AntD providers + the settings drill shell harness. Uses the
 * testing-library `wrapper` option so `rerender` re-applies the same persistent
 * harness instance (drill state survives a rerender, e.g. an auth-generation
 * change), matching how the real shell keeps drill state across re-renders.
 */
export function renderWithSettingsShell(ui: ReactNode, section?: SettingsSection) {
  const SettingsShellWrapper = ({ children }: { children: ReactNode }) => (
    <ConfigProvider theme={{ hashed: false }}>
      <AntApp>
        <StandaloneSettingsDrillProvider section={section}>
          {children}
        </StandaloneSettingsDrillProvider>
      </AntApp>
    </ConfigProvider>
  );
  return render(ui, { wrapper: SettingsShellWrapper });
}
