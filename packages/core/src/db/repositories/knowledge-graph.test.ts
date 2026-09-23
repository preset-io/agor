import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { update } from '../database-wrapper';
import { kbGraphNodes } from '../schema';
import { dbTest } from '../test-helpers';
import { KnowledgeGraphRepository } from './knowledge';

dbTest(
  'restores archived reference identity and preserves manual metadata and unrelated edge types',
  async ({ db }) => {
    const graph = new KnowledgeGraphRepository(db);
    const source = { uri: 'https://fixture.invalid/source' };
    const target = { uri: 'https://fixture.invalid/target' };
    const manual = await graph.link({
      source,
      target,
      edge_type: 'references',
      confidence: 0.8,
      properties: { manual: true },
    });
    const unrelated = await graph.link({ source, target, edge_type: 'related_to' });
    await graph.syncOutgoingEdges({ source, edge_type: 'references', targets: [] });
    expect((await graph.neighbors({ node: source })).edges.map((edge) => edge.edge_id)).toEqual([
      unrelated.edge_id,
    ]);
    await graph.syncOutgoingEdges({
      source,
      edge_type: 'references',
      targets: [target, target, source],
    });
    await graph.syncOutgoingEdges({ source, edge_type: 'references', targets: [target] });
    const edges = (await graph.neighbors({ node: source })).edges;
    expect(edges).toHaveLength(2);
    expect(edges.find((edge) => edge.edge_type === 'references')).toMatchObject({
      edge_id: manual.edge_id,
      confidence: 0.8,
      properties: { manual: true },
      archived: false,
    });
  }
);

dbTest('restores archived nodes consistently by ID and URI when linking', async ({ db }) => {
  const graph = new KnowledgeGraphRepository(db);
  const source = await graph.getOrCreateNode({ uri: 'https://fixture.invalid/source' });
  const target = { uri: 'https://fixture.invalid/target' };
  for (const ref of [{ node_id: source.node_id }, { uri: source.uri }]) {
    await update(db, kbGraphNodes)
      .set({ archived: true, archived_at: new Date(), metadata: { retained: true } })
      .where(eq(kbGraphNodes.node_id, source.node_id))
      .run();
    await graph.link({ source: ref, target, edge_type: 'references' });
    const result = await graph.neighbors({ node: ref, direction: 'out' });
    expect(result.center).toMatchObject({
      node_id: source.node_id,
      archived: false,
      archived_at: null,
      metadata: { retained: true },
      created_at: source.created_at,
    });
    expect(result.edges).toHaveLength(1);
  }
});
