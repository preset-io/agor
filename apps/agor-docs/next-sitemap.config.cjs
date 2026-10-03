const siteOrigin = (process.env.NEXT_PUBLIC_SITE_URL || 'https://agor.live').replace(/\/+$/, '');
const basePath = process.env.NEXT_PUBLIC_BASE_PATH
  ? `/${process.env.NEXT_PUBLIC_BASE_PATH.replace(/^\/+|\/+$/g, '')}`
  : '';
const siteUrl = `${siteOrigin}${basePath}`;

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
  exclude: ['/404', '/_app', '/_document', '/guide/assistants'],

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
