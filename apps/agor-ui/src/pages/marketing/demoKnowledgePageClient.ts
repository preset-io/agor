// Demo-only stub AgorClient for the real KnowledgePage.tsx — see
// demoKnowledgePageData.ts for the fixture data and the navigate() safety
// note. Covers exactly the service calls KnowledgePage's default (no doc
// open) view makes; everything else throws loudly rather than silently
// resolving to nothing.

import type { User } from '@agor-live/client';
import { ROLES } from '@agor-live/client';
import {
  demoKnowledgeDocuments,
  demoKnowledgeGraph,
  demoKnowledgeNamespace,
  demoKnowledgeVersionByDocId,
} from './demoKnowledgePageData';

// Clicking a search result (like opening a doc from the tree) calls
// navigate() in the real component — see demoKnowledgePageData.ts's safety
// note. The scene types a query and shows results appearing but never
// clicks one, so this only needs to answer the search itself.
const search = async (params: { query?: { q?: string } }) => {
  const q = (params?.query?.q ?? '').toLowerCase();
  return demoKnowledgeDocuments
    .filter((doc) => doc.title.toLowerCase().includes(q))
    .map((doc) => ({
      document: doc,
      namespace: demoKnowledgeNamespace,
      score: 1,
      snippet: demoKnowledgeVersionByDocId[doc.document_id]?.content_text.slice(0, 120),
    }));
};

export const DEMO_KNOWLEDGE_USER = {
  user_id: 'demo-user-knowledge',
  name: 'Devon',
  email: 'devon@example.com',
  emoji: '🛠️',
  role: ROLES.ADMIN,
} as unknown as User;

const noop = () => undefined;
const emitter = () => ({ on: noop, off: noop, removeListener: noop });

export function createDemoKnowledgePageClient() {
  const service = (path: string) => {
    switch (path) {
      case 'kb/namespaces':
        return { find: async () => [demoKnowledgeNamespace], ...emitter() };
      case 'kb/documents':
        return { find: async () => demoKnowledgeDocuments, ...emitter() };
      case 'kb/graph':
        return { find: async () => demoKnowledgeGraph, ...emitter() };
      case 'kb/versions':
        return {
          find: async (params: { query?: { document_id?: string } }) => {
            const docId = params?.query?.document_id;
            const version = docId ? demoKnowledgeVersionByDocId[docId] : undefined;
            return version ? [version] : [];
          },
          ...emitter(),
        };
      case 'kb/search':
        return { find: search, ...emitter() };
      case 'kb/settings':
        return {
          find: async () => ({ embedding_provider: null, embedding_model: null }),
          ...emitter(),
        };
      case 'kb/indexing/status':
        return {
          find: async () => ({
            enabled: false,
            configured: false,
            dialect: 'sqlite',
            pgvector_available: false,
          }),
          ...emitter(),
        };
      case 'groups':
        return { findAll: async () => [], ...emitter() };
      case 'users':
        return { findAll: async () => [DEMO_KNOWLEDGE_USER], ...emitter() };
      default:
        throw new Error(`demoKnowledgePageClient: unstubbed service "${path}"`);
    }
  };

  return {
    service,
    io: emitter(),
  };
}
