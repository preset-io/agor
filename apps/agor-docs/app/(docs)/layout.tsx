import { getPageMap } from 'nextra/page-map';
import { Layout } from 'nextra-theme-docs';
import type { ReactNode } from 'react';
import { MermaidZoom } from '../../components/MermaidZoom';
import { footer, navbar, sharedLayoutProps } from '../docsTheme';

export default async function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <Layout navbar={navbar} pageMap={await getPageMap()} footer={footer} {...sharedLayoutProps}>
      {children}
      <MermaidZoom />
    </Layout>
  );
}
