/** @type {import('next-sitemap').IConfig} */
module.exports = {
  siteUrl: 'https://agor.live',
  generateRobotsTxt: false, // We use custom robots.txt in public/
  outDir: './out',
  changefreq: 'weekly',
  priority: 0.7,
  sitemapSize: 5000,
  exclude: ['/404', '/_app', '/_document'],

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
