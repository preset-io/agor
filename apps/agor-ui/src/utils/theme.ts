/**
 * Shared theme helpers.
 *
 * Centralizes theme detection logic so components can make consistent
 * decisions based on the current Ant Design token values.
 */
export const isDarkTheme = (token: { colorBgLayout?: string | undefined }): boolean =>
  token.colorBgLayout?.startsWith?.('#0') ||
  token.colorBgLayout?.startsWith?.('rgb(0') ||
  token.colorBgLayout?.startsWith?.('rgba(0') ||
  false;
