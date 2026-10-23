// Fixture data + stub client for the "knowledge" scene, driving the REAL
// KnowledgePage.tsx (sidebar tree, search bar, tabs, graph — all of it),
// not a hand-rolled recreation. KnowledgePage reads everything through
// `client.service('kb/...')`, so this stub answers exactly those calls from
// fixture data, same technique as demoMarketplaceClient.ts.
//
// IMPORTANT: selecting a document in the real sidebar tree calls
// `navigate()` (KnowledgePage mirrors the open doc into the URL), and this
// whole demo route is itself selected by an exact `location.pathname`
// check in AppWrapper — see App.tsx's `isMarketingVideoRoute`. Any
// navigate() away from `/demo/marketing-video` would unmount this page and
// mount the real app shell mid-capture. KnowledgePage only calls navigate()
// from effects/handlers gated on `activeDoc` being set, so the scene
// deliberately never opens a document — it stays on the default graph-home
// view (`activeDocId === null`), where navigation is never triggered.

import type {
  KnowledgeDocument,
  KnowledgeGraphDocEdge,
  KnowledgeGraphDocNode,
  KnowledgeNamespace,
  KnowledgeNamespaceGraph,
} from '@agor/core/types';

export const KNOWLEDGE_NAMESPACE_SLUG = 'global';
const NAMESPACE_ID = 'demo-kb-namespace-global';

export const demoKnowledgeNamespace: KnowledgeNamespace = {
  namespace_id: NAMESPACE_ID,
  slug: KNOWLEDGE_NAMESPACE_SLUG,
  display_name: 'Global',
  kind: 'global',
  visibility_default: 'public',
  others_can: 'write',
  archived: false,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
} as unknown as KnowledgeNamespace;

interface DemoDocSeed {
  id: string;
  path: string;
  title: string;
  icon: string;
  content: string;
}

const DOC_SEEDS: DemoDocSeed[] = [
  {
    id: 'demo-doc-launch-plan',
    path: 'launch/plan',
    title: 'Launch plan',
    icon: '🚀',
    content: `**Target date:** the week of the conference.

## Messaging
See **GTM messaging** for the approved positioning — multiplayer canvas,
parallel agents on worktrees, MCP self-orchestration, persistent Slack
teammate.

## Open items
- Landing page copy — draft, awaiting review
- Pricing FAQ — published
- Booth loop videos — in progress
`,
  },
  {
    id: 'demo-doc-gtm-messaging',
    path: 'launch/gtm-messaging',
    title: 'GTM messaging',
    icon: '📣',
    content: `## Positioning

Agor is a multiplayer canvas for orchestrating AI coding agents — not
another chat window.

## Pillars
1. Parallel agents on real git worktrees
2. MCP self-orchestration
3. A persistent teammate in Slack
`,
  },
  {
    id: 'demo-doc-landing-copy',
    path: 'launch/landing-copy',
    title: 'Landing page copy',
    icon: '📝',
    content: `## Hero
"Your whole team, every agent, one canvas."

## Status
Draft — awaiting review from design.
`,
  },
  {
    id: 'demo-doc-pricing-faq',
    path: 'launch/pricing-faq',
    title: 'Pricing FAQ',
    icon: '💬',
    content: `## Is there a free tier?
Yes — solo use is free.

## How is usage metered?
Per active branch-hour, not per seat.
`,
  },
  {
    id: 'demo-doc-design-notes',
    path: 'product/design-notes',
    title: 'Design system notes',
    icon: '🎨',
    content: `## Tokens
Dark-first. Teal primary (\`#14b8a6\`).

## Motion
Calm by default — one zoom or one pan per beat, not both.
`,
  },
];

const now = new Date('2026-08-25T00:00:00.000Z');

export const demoKnowledgeDocuments: KnowledgeDocument[] = DOC_SEEDS.map((seed) => ({
  document_id: seed.id,
  namespace_id: NAMESPACE_ID,
  path: seed.path,
  uri: `agor://knowledge/${seed.path}`,
  title: seed.title,
  icon_emoji: seed.icon,
  kind: 'doc',
  visibility: 'public',
  status: 'published',
  edit_policy: 'public',
  current_version_id: `${seed.id}-v1`,
  created_at: now,
  updated_at: now,
  archived: false,
})) as unknown as KnowledgeDocument[];

export const demoKnowledgeVersionByDocId: Record<
  string,
  { version_id: string; content_text: string }
> = Object.fromEntries(
  DOC_SEEDS.map((seed) => [seed.id, { version_id: `${seed.id}-v1`, content_text: seed.content }])
);

const graphNodes: KnowledgeGraphDocNode[] = DOC_SEEDS.map((seed) => ({
  document_id: seed.id,
  title: seed.title,
  icon_emoji: seed.icon,
  path: seed.path,
  uri: `agor://knowledge/${seed.path}`,
  kind: 'doc',
  visibility: 'public',
  status: 'published',
}));

const graphEdges: KnowledgeGraphDocEdge[] = [
  {
    source_document_id: 'demo-doc-launch-plan',
    target_document_id: 'demo-doc-gtm-messaging',
    edge_type: 'references',
  },
  {
    source_document_id: 'demo-doc-launch-plan',
    target_document_id: 'demo-doc-landing-copy',
    edge_type: 'references',
  },
  {
    source_document_id: 'demo-doc-launch-plan',
    target_document_id: 'demo-doc-pricing-faq',
    edge_type: 'mentions',
  },
  {
    source_document_id: 'demo-doc-gtm-messaging',
    target_document_id: 'demo-doc-design-notes',
    edge_type: 'references',
  },
];

export const demoKnowledgeGraph: KnowledgeNamespaceGraph = {
  namespace_id: NAMESPACE_ID,
  nodes: graphNodes,
  edges: graphEdges,
};
