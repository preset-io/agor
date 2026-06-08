import nextra from 'nextra';

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
  latex: true,
  defaultShowCopyCode: true,
});

const basePath = process.env.NEXT_PUBLIC_BASE_PATH
  ? `/${process.env.NEXT_PUBLIC_BASE_PATH.replace(/^\/+|\/+$/g, '')}`
  : '';

// Deployed to custom domain agor.live (no base path needed)
export default withNextra({
  reactStrictMode: true,
  output: 'export',
  images: {
    unoptimized: true,
  },
  basePath,
});
