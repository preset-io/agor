import { App as AntApp, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo } from 'react';

export const STREAMDOWN_PORTAL_ROOT_CLASS_NAME = 'streamdown-portal-root';
export const STREAMDOWN_FULLSCREEN_Z_INDEX_VARIABLE = '--streamdown-fullscreen-z-index';

interface StreamdownPortalStyle extends React.CSSProperties {
  '--streamdown-fullscreen-z-index': number;
}

/**
 * Keeps Streamdown portals aligned with Ant Design's theme.
 *
 * Mermaid accepts Ant App's popup container and stays inside its CSS-variable
 * scope. Streamdown's table fullscreen view, however, portals directly to
 * `document.body`. Mirror the semantic variables used by Streamdown onto body
 * so that portal also inherits the active light, dark, or custom theme.
 */
export const StreamdownPortalApp: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { token } = theme.useToken();
  const style = useMemo<StreamdownPortalStyle>(
    () => ({ '--streamdown-fullscreen-z-index': token.zIndexPopupBase }),
    [token.zIndexPopupBase]
  );
  const bodyPortalTokens = useMemo(
    () => ({
      '--ant-color-bg-container': token.colorBgContainer,
      '--ant-color-bg-layout': token.colorBgLayout,
      '--ant-color-border-secondary': token.colorBorderSecondary,
      '--ant-color-fill-tertiary': token.colorFillTertiary,
      '--ant-color-primary': token.colorPrimary,
      '--ant-color-text': token.colorText,
      '--ant-color-text-light-solid': token.colorTextLightSolid,
      '--ant-color-text-secondary': token.colorTextSecondary,
      '--ant-font-family': token.fontFamily,
      '--streamdown-fullscreen-z-index': String(token.zIndexPopupBase),
    }),
    [
      token.colorBgContainer,
      token.colorBgLayout,
      token.colorBorderSecondary,
      token.colorFillTertiary,
      token.colorPrimary,
      token.colorText,
      token.colorTextLightSolid,
      token.colorTextSecondary,
      token.fontFamily,
      token.zIndexPopupBase,
    ]
  );

  useEffect(() => {
    const previousValues = new Map<string, string>();
    for (const [name, value] of Object.entries(bodyPortalTokens)) {
      previousValues.set(name, document.body.style.getPropertyValue(name));
      document.body.style.setProperty(name, value);
    }
    return () => {
      for (const [name, value] of previousValues) {
        if (value) {
          document.body.style.setProperty(name, value);
        } else {
          document.body.style.removeProperty(name);
        }
      }
    };
  }, [bodyPortalTokens]);

  return (
    <AntApp className={STREAMDOWN_PORTAL_ROOT_CLASS_NAME} style={style}>
      {children}
    </AntApp>
  );
};
