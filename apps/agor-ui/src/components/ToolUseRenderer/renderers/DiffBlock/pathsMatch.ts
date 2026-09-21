/** Match executor-enriched paths to tool input paths, including relative paths. */
export const pathsMatch = (left: string, right: string): boolean => {
  const a = left.replace(/\\/g, '/');
  const b = right.replace(/\\/g, '/');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
};
