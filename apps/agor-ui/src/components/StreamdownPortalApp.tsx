import { App as AntApp, theme } from 'antd';
import type React from 'react';
import { useMemo } from 'react';

export const STREAMDOWN_PORTAL_ROOT_CLASS_NAME = 'streamdown-portal-root';
export const STREAMDOWN_MERMAID_Z_INDEX_VARIABLE = '--streamdown-mermaid-z-index';

interface StreamdownPortalStyle extends React.CSSProperties {
  '--streamdown-mermaid-z-index': number;
}

/**
 * Keeps Streamdown's Mermaid fullscreen portal inside Ant App's CSS-variable
 * scope and exposes the non-emitted popup stacking token to scoped CSS.
 */
export const StreamdownPortalApp: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { token } = theme.useToken();
  const style = useMemo<StreamdownPortalStyle>(
    () => ({ '--streamdown-mermaid-z-index': token.zIndexPopupBase }),
    [token.zIndexPopupBase]
  );

  return (
    <AntApp className={STREAMDOWN_PORTAL_ROOT_CLASS_NAME} style={style}>
      {children}
    </AntApp>
  );
};
