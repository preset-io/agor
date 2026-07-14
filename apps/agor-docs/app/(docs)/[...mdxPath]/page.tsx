import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importPage } from 'nextra/pages';
import { FAQ_SCHEMA } from '../../../lib/faqSchema';
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  type FrontMatterLike,
  getCanonicalUrl,
  getSocialImage,
} from '../../../lib/siteMetadata';
import { useMDXComponents as getMDXComponents } from '../../../mdx-components';

const contentDir = join(process.cwd(), 'content');

function collectMdxPaths(dir = contentDir): string[][] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      return collectMdxPaths(fullPath);
    }

    if (!entry.endsWith('.mdx')) {
      return [];
    }

    const withoutExtension = relative(contentDir, fullPath).replace(/\.mdx$/, '');

    if (withoutExtension === 'index') {
      return [];
    }

    if (withoutExtension.endsWith('/index')) {
      return [withoutExtension.replace(/\/index$/, '').split('/')];
    }

    return [withoutExtension.split('/')];
  });
}

export function generateStaticParams() {
  return collectMdxPaths().map((mdxPath) => ({ mdxPath }));
}

type PageProps = {
  params: Promise<{ mdxPath?: string[] }>;
};

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  const { metadata } = await importPage(params.mdxPath);
  const pathname = `/${params.mdxPath?.join('/') ?? ''}`;
  const pageTitle = metadata.title ?? 'agor';
  const title = pageTitle === 'agor' ? DEFAULT_TITLE : `${pageTitle} – agor`;
  const description = metadata.description || DEFAULT_DESCRIPTION;
  const frontMatter = metadata as FrontMatterLike;
  const image = getSocialImage(frontMatter);

  return {
    title,
    description,
    alternates: {
      canonical: getCanonicalUrl(pathname, frontMatter.canonical),
    },
    openGraph: {
      type: frontMatter.date ? 'article' : 'website',
      siteName: 'Agor',
      title,
      description,
      url: getCanonicalUrl(pathname, frontMatter.canonical),
      images: [
        {
          url: image,
          width: frontMatter.imageWidth,
          height: frontMatter.imageHeight,
        },
      ],
      publishedTime: frontMatter.date ? new Date(frontMatter.date).toISOString() : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}

const Wrapper = getMDXComponents().wrapper;

export default async function Page(props: PageProps) {
  const params = await props.params;
  const { default: MDXContent, toc, metadata, sourceCode } = await importPage(params.mdxPath);
  const frontMatter = metadata as FrontMatterLike;
  const pathname = `/${params.mdxPath?.join('/') ?? ''}`;
  const isBlogPost = params.mdxPath?.[0] === 'blog' && params.mdxPath.length > 1;
  const blogPostingSchema =
    isBlogPost && frontMatter.date
      ? {
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: frontMatter.title,
          description: frontMatter.description,
          datePublished: new Date(frontMatter.date).toISOString(),
          image: getSocialImage(frontMatter),
          url: getCanonicalUrl(pathname, frontMatter.canonical),
          author: { '@type': 'Organization', name: 'Preset Inc.', url: 'https://preset.io' },
          publisher: { '@type': 'Organization', name: 'Preset Inc.', url: 'https://preset.io' },
        }
      : null;

  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      {/* FAQPage structured data — mirrors the visible Q&A in content/faq.mdx
          (see lib/faqSchema.ts). */}
      {params.mdxPath?.length === 1 && params.mdxPath[0] === 'faq' ? (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is static and controlled, not user-provided.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_SCHEMA) }}
        />
      ) : null}
      {blogPostingSchema ? (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is static and controlled, not user-provided.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostingSchema) }}
        />
      ) : null}
      {frontMatter.image && isBlogPost ? (
        // biome-ignore lint/performance/noImgElement: Static blog hero image
        <img
          src={frontMatter.image}
          alt=""
          style={{
            width: '100%',
            borderRadius: '8px',
            marginBottom: '1.5rem',
            aspectRatio: '16 / 9',
            objectFit: 'cover',
          }}
        />
      ) : null}
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
