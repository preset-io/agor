// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Staged Knowledge panel for the demo-video "knowledge" scene — the REAL
// KnowledgePage.tsx (sidebar tree, search bar, tabs, the real KnowledgeGraph
// force layout), backed by the stub client in demoKnowledgePageClient.ts.
// See that file's header comment for why the scene never opens a document
// (KnowledgePage's own navigate()-on-open would unmount this whole route).

import { theme } from 'antd';
import { KnowledgePage } from '../KnowledgePage';
import { createDemoKnowledgePageClient, DEMO_KNOWLEDGE_USER } from './demoKnowledgePageClient';

const DEMO_CLIENT = createDemoKnowledgePageClient();

export const DemoKnowledgeStage = () => {
  const { token } = theme.useToken();

  return (
    <div
      data-testid="demo-knowledge-stage"
      style={{
        position: 'absolute',
        top: 64,
        left: '6%',
        right: '6%',
        bottom: '5%',
        zIndex: 30,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
        boxShadow: '0 24px 90px rgba(0, 0, 0, 0.5)',
        border: `1px solid ${token.colorBorder}`,
      }}
    >
      <KnowledgePage
        // biome-ignore lint/suspicious/noExplicitAny: demo-only stub client, not a real AgorClient
        client={DEMO_CLIENT as any}
        currentUser={DEMO_KNOWLEDGE_USER}
      />
    </div>
  );
};
