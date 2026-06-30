import { importPage } from 'nextra/pages';
import { DEFAULT_DESCRIPTION, getCanonicalUrl, getSocialImage } from '../lib/siteMetadata';

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

  return <MDXContent />;
}
