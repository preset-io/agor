import nextra from 'nextra';

const withNextra = nextra({
  latex: true,
  defaultShowCopyCode: true,
});

const basePath = process.env.NEXT_PUBLIC_BASE_PATH
  ? `/${process.env.NEXT_PUBLIC_BASE_PATH.replace(/^\/+|\/+$/g, '')}`
  : '';

// Deployed to custom domain agor.live (no base path needed)
export default withNextra({
  reactStrictMode: true,
  devIndicators: false,
  output: 'export',
  images: {
    unoptimized: true,
  },
  basePath,
});
