import { getPageMap } from 'nextra/page-map';
import { importPage } from 'nextra/pages';
import { Layout } from 'nextra-theme-docs';
import { DEFAULT_DESCRIPTION, getCanonicalUrl, getSocialImage } from '../lib/siteMetadata';
import { navbar, sharedLayoutProps } from './docsTheme';

export async function generateMetadata() {
  const { metadata } = await importPage([]);
  const title = 'agor – Team command center for all things agentic';
  const description = metadata.description || DEFAULT_DESCRIPTION;
  const image = getSocialImage(metadata as Record<string, unknown>);

  return {
    title,
    description,
    alternates: {
      canonical: getCanonicalUrl('/'),
    },
    openGraph: {
      type: 'website',
      siteName: 'Agor',
      title,
      description,
      url: getCanonicalUrl('/'),
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}

export default async function HomePage() {
  const { default: MDXContent } = await importPage([]);

  return (
    <Layout navbar={navbar} pageMap={await getPageMap()} {...sharedLayoutProps}>
      <MDXContent />
    </Layout>
  );
}
