const siteOrigin = (process.env.NEXT_PUBLIC_SITE_URL || 'https://agor.live').replace(/\/+$/, '');
const basePath = process.env.NEXT_PUBLIC_BASE_PATH
  ? `/${process.env.NEXT_PUBLIC_BASE_PATH.replace(/^\/+|\/+$/g, '')}`
  : '';
const siteUrl = `${siteOrigin}${basePath}`;

const fs = require('node:fs');
const path = require('node:path');

// Pages that must stay out of the sitemap, read from their frontmatter:
// `noindex: true` (redirect stubs and moved pages), and blog posts dated in
// the future (the blog hides them until 06:00 PST on their date; see
// lib/blogPublication.ts). The sitemap is rebuilt with every deploy.
function unlistedPages() {
  const root = path.join(__dirname, 'content');
  const now = Date.now();
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.mdx')) continue;
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(full, 'utf8'))?.[1] ?? '';
      const route = `/${path
        .relative(root, full)
        .replace(/\.mdx$/, '')
        .replace(/(^|\/)index$/, '')}`;
      const noindex = /^noindex:\s*true\s*$/m.test(frontmatter);
      const date = /^date:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(frontmatter)?.[1];
      const unpublished =
        route.startsWith('/blog/') && date && Date.parse(`${date}T06:00:00-08:00`) > now;
      if (noindex || unpublished) found.push(route);
    }
  };
  walk(root);
  return found;
}

/** @type {import('next-sitemap').IConfig} */
module.exports = {
  siteUrl,
  generateRobotsTxt: false, // We use custom robots.txt in public/
  outDir: './out',
  changefreq: 'weekly',
  priority: 0.7,
  sitemapSize: 5000,
  // /guide/assistants is a meta-refresh redirect stub to /guide/teammates —
  // redirect pages don't belong in the sitemap.
  exclude: ['/404', '/_app', '/_document', '/guide/assistants', ...unlistedPages()],

  // Include static LLM-related files
  additionalPaths: async () => [
    { loc: '/llms.txt', changefreq: 'monthly', priority: 0.3 },
    { loc: '/llms-full.txt', changefreq: 'monthly', priority: 0.3 },
  ],

  // Custom transform for specific pages
  transform: async (config, path) => {
    // Higher priority for key pages
    if (path === '/') {
      return {
        loc: path,
        changefreq: 'daily',
        priority: 1.0,
        lastmod: new Date().toISOString(),
      };
    }

    if (path.startsWith('/guide')) {
      return {
        loc: path,
        changefreq: 'weekly',
        priority: 0.9,
        lastmod: new Date().toISOString(),
      };
    }

    if (path.startsWith('/api-reference')) {
      return {
        loc: path,
        changefreq: 'weekly',
        priority: 0.8,
        lastmod: new Date().toISOString(),
      };
    }

    if (path.startsWith('/blog')) {
      return {
        loc: path,
        changefreq: 'monthly',
        priority: 0.8,
        lastmod: new Date().toISOString(),
      };
    }

    // Default transformation
    return {
      loc: path,
      changefreq: config.changefreq,
      priority: config.priority,
      lastmod: new Date().toISOString(),
    };
  },
};
