// biome-ignore-all lint/plugin/noHardcodedColorLiteral: centralized syntax-diff palette encodes added and removed lines

/** Exact syntax colors for diff lines and word-level changes. */
export const getDiffPalette = (isDark: boolean) => ({
  addBg: isDark ? 'rgba(46, 160, 67, 0.15)' : 'rgba(46, 160, 67, 0.1)',
  removeBg: isDark ? 'rgba(218, 54, 51, 0.15)' : 'rgba(218, 54, 51, 0.1)',
  addColor: isDark ? '#3fb950' : '#1a7f37',
  removeColor: isDark ? '#f85149' : '#cf222e',
  addWordBg: isDark ? 'rgba(46, 160, 67, 0.4)' : 'rgba(46, 160, 67, 0.3)',
  removeWordBg: isDark ? 'rgba(218, 54, 51, 0.4)' : 'rgba(218, 54, 51, 0.3)',
});
