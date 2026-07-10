import { useMDXComponents as getDocsThemeComponents } from 'nextra-theme-docs';

export function useMDXComponents(components = {}) {
  return {
    ...getDocsThemeComponents(),
    ...components,
  };
}
