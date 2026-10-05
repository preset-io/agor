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
  // Remote docs previews allow only their own public origin for dev assets/HMR.
  // Never a wildcard, and ordinary local/production builds are unchanged.
  ...(process.env.AGOR_DOCS_PREVIEW_ORIGIN
    ? { allowedDevOrigins: [new URL(process.env.AGOR_DOCS_PREVIEW_ORIGIN).hostname] }
    : {}),
  output: 'export',
  images: {
    unoptimized: true,
  },
  basePath,
  // Lets a throwaway preview server (e.g. an agent's `next dev` on a scratch
  // port) build into its own folder, so it can't collide with `pnpm serve`.
  distDir: process.env.AGOR_DOCS_DIST_DIR || '.next',
});
