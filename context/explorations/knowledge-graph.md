# Knowledge Graph & Vector Search

**Status:** Exploration
**Last Updated:** 2025-01-10
**Related:** [[architecture.md]], [[models.md]], [[worktrees.md]]

---

## Vision

Enable semantic search and relationship discovery across Agor's sessions, tasks, and messages using a hybrid knowledge graph + vector embedding system.

**Key capabilities:**

- "Find sessions about authentication strategies" (semantic search)
- "Show me what files this session touched" (graph traversal)
- "What concepts appear together often?" (pattern discovery)
- "Find solutions to similar problems" (cross-session learning)

**Design principle:** Postgres-only premium feature with lazy background indexing.

---

## User Value

### Discovery & Navigation

- "I remember an agent worked on authentication... but which session was that?"
- "Where did we discuss rate limiting strategies?"
- "Find all places where we talked about WebSocket performance"

### Context Retrieval for New Work

- Starting a new session: "Search all previous work in this worktree for relevant context about the payment system"
- Agent onboarding: "Before I start, let me see what's already been tried/discussed"

### Cross-Session Learning

- "Show me all sessions where agents struggled with TypeScript type errors"
- "What solutions have other agents found for database migration issues?"
- "Has anyone in any worktree dealt with CORS problems?"

### Institutional Knowledge (with archiving)

- Deleted sessions still valuable: "That experimental branch is gone, but what did we learn?"
- Failed approaches: "What didn't work and why?"
- Prevents reinventing wheels across teams/worktrees

### Agent Collaboration

- Agent A: "Search for any session that mentions Redis caching strategies"
- Agents can learn from each other's work without explicit handoff
- "Show me reports from sessions that worked on similar features"

---

## Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                     Agor Daemon (FeathersJS)                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Feathers Services (sessions, tasks, messages, etc.)         │
│              ↓ (after hooks)                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │         Knowledge Graph Indexer (lazy worker)          │ │
│  │                                                         │ │
│  │  • Listens to: session.created, task.created,         │ │
│  │                message.created, file edits            │ │
│  │  • Queues indexing jobs (in-memory or pg_queue)       │ │
│  │  • Processes asynchronously (doesn't block API)       │ │
│  │  • Computes embeddings (OpenAI API or local model)    │ │
│  │  • Updates graph + vectors in Postgres               │ │
│  └────────────────────────────────────────────────────────┘ │
│              ↓                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │            Postgres (AGE + pgvector)                   │ │
│  │                                                         │ │
│  │  • Graph nodes/edges (AGE)                            │ │
│  │  • Vector embeddings (pgvector)                       │ │
│  │  • Full-text search (pg_trgm)                         │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Technology Stack

**Postgres Extensions:**

- **Apache AGE** - OpenCypher graph queries in Postgres
- **pgvector** - Vector similarity search (HNSW indexes)
- **pg_trgm** - Fuzzy full-text search

**Why Postgres-only?**

- LibSQL/Turso: Stay lightweight, no extensions needed
- Postgres: Premium features for teams wanting advanced search
- Single DB for relational + graph + vectors (no separate services)

---

## Schema Design

### 1. Graph Structure (Apache AGE)

Graph lives alongside relational schema via AGE extension:

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create graph
SELECT create_graph('agor_knowledge');
```

**Node Types:**

- `Session` - AI agent sessions
- `Task` - User prompts/tasks within sessions
- `Worktree` - Git worktrees
- `File` - Files edited by sessions
- `Concept` - Extracted technical concepts (JWT, Redis, WebSocket, etc.)
- `Problem` - Issues encountered/solved

**Relationship Types:**

- `[:WORKS_ON]` - Session → Worktree
- `[:SPAWNED]` - Session → Session (parent/child)
- `[:FORKED_FROM]` - Session → Session (fork relationship)
- `[:EDITED]` - Session → File
- `[:MENTIONS]` - Session/Task → Concept
- `[:SOLVED]` - Session → Problem
- `[:ENCOUNTERED]` - Session → Problem
- `[:CO_MENTIONED]` - Concept ↔ Concept (appear together)
- `[:IMPORTS]` - File → File (code dependencies)

### 2. Embeddings Table (pgvector)

```sql
CREATE TABLE embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What we're embedding
  entity_type TEXT NOT NULL, -- 'session', 'task', 'message', 'report'
  entity_id TEXT NOT NULL,   -- Foreign key to entity

  -- Content metadata
  content_hash TEXT NOT NULL, -- SHA256 of embedded content (for dedup)
  content_preview TEXT,       -- First 200 chars

  -- Vector
  embedding vector(1536) NOT NULL, -- OpenAI ada-002 dimensions

  -- Indexing metadata
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_version TEXT NOT NULL DEFAULT 'text-embedding-ada-002',

  -- Fast lookups
  worktree_id TEXT NOT NULL,
  session_id TEXT,

  UNIQUE(entity_type, entity_id, model_version)
);

-- Vector similarity index (HNSW for fast ANN search)
CREATE INDEX ON embeddings
  USING hnsw (embedding vector_cosine_ops);

-- Filtering indexes
CREATE INDEX ON embeddings (worktree_id, entity_type);
CREATE INDEX ON embeddings (session_id);
CREATE INDEX ON embeddings (indexed_at DESC);

-- Full-text index
CREATE INDEX ON embeddings USING gin (content_preview gin_trgm_ops);
```

### 3. Index Queue (Background Job Processing)

```sql
CREATE TABLE index_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Job details
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL, -- 'create', 'update', 'delete'

  -- Metadata
  worktree_id TEXT NOT NULL,
  session_id TEXT,

  -- Queue state
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  priority INT NOT NULL DEFAULT 0, -- Higher = process first

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Error tracking
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,

  -- Payload (for processing)
  data JSONB NOT NULL,

  UNIQUE(entity_type, entity_id) -- Prevent duplicate jobs
);

CREATE INDEX ON index_queue (status, priority DESC, created_at ASC);
CREATE INDEX ON index_queue (worktree_id);
```

---

## Background Indexer

### Core Indexer Service

```typescript
// packages/core/src/knowledge-graph/indexer.ts

import { EventEmitter } from 'events';
import type { Database } from '@agor/core/db';
import { embed } from './embeddings';
import { updateGraph } from './graph-updater';

export interface IndexJob {
  entity_type: 'session' | 'task' | 'message' | 'report';
  entity_id: string;
  operation: 'create' | 'update' | 'delete';
  worktree_id: string;
  session_id?: string;
  data: any;
}

export class KnowledgeGraphIndexer extends EventEmitter {
  private queue: IndexJob[] = [];
  private processing = false;
  private batchSize = 10;

  constructor(private db: Database) {
    super();
    this.startWorker();
  }

  /**
   * Queue an entity for indexing (non-blocking)
   */
  async enqueue(job: IndexJob) {
    // Insert into Postgres queue
    await this.db.execute(sql`
      INSERT INTO index_queue (
        entity_type, entity_id, operation,
        worktree_id, session_id, data
      )
      VALUES (${job.entity_type}, ${job.entity_id}, ${job.operation},
              ${job.worktree_id}, ${job.session_id}, ${JSON.stringify(job.data)})
      ON CONFLICT (entity_type, entity_id)
      DO UPDATE SET
        operation = EXCLUDED.operation,
        data = EXCLUDED.data,
        status = 'pending',
        created_at = NOW()
    `);

    this.emit('job:queued', job);
  }

  /**
   * Background worker (polls queue and processes)
   */
  private async startWorker() {
    setInterval(async () => {
      if (this.processing) return;

      try {
        this.processing = true;
        await this.processBatch();
      } catch (err) {
        console.error('Indexer error:', err);
      } finally {
        this.processing = false;
      }
    }, 5000); // Poll every 5 seconds
  }

  /**
   * Process a batch of jobs
   */
  private async processBatch() {
    // Fetch pending jobs
    const jobs = await this.db.query(sql`
      SELECT * FROM index_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT ${this.batchSize}
      FOR UPDATE SKIP LOCKED -- Prevent concurrent processing
    `);

    if (jobs.length === 0) return;

    // Mark as processing
    await this.db.execute(sql`
      UPDATE index_queue
      SET status = 'processing', started_at = NOW()
      WHERE id = ANY(${jobs.map(j => j.id)})
    `);

    // Process each job
    for (const job of jobs) {
      try {
        await this.processJob(job);

        // Mark completed
        await this.db.execute(sql`
          UPDATE index_queue
          SET status = 'completed', completed_at = NOW()
          WHERE id = ${job.id}
        `);

        this.emit('job:completed', job);
      } catch (err) {
        // Mark failed
        await this.db.execute(sql`
          UPDATE index_queue
          SET status = 'failed',
              attempts = attempts + 1,
              last_error = ${err.message}
          WHERE id = ${job.id}
        `);

        this.emit('job:failed', { job, error: err });
      }
    }
  }

  /**
   * Process a single indexing job
   */
  private async processJob(job: IndexJob) {
    switch (job.operation) {
      case 'create':
      case 'update':
        await this.indexEntity(job);
        break;
      case 'delete':
        await this.deleteEntity(job);
        break;
    }
  }

  /**
   * Index an entity (compute embedding + update graph)
   */
  private async indexEntity(job: IndexJob) {
    const { entity_type, entity_id, data } = job;

    // 1. Extract content to embed
    const content = this.extractContent(entity_type, data);

    // 2. Compute embedding
    const embedding = await embed(content);

    // 3. Store embedding
    await this.db.execute(sql`
      INSERT INTO embeddings (
        entity_type, entity_id, embedding,
        content_hash, content_preview,
        worktree_id, session_id
      )
      VALUES (
        ${entity_type}, ${entity_id}, ${embedding},
        ${this.hash(content)}, ${content.slice(0, 200)},
        ${job.worktree_id}, ${job.session_id}
      )
      ON CONFLICT (entity_type, entity_id, model_version)
      DO UPDATE SET
        embedding = EXCLUDED.embedding,
        content_hash = EXCLUDED.content_hash,
        indexed_at = NOW()
    `);

    // 4. Update graph
    await updateGraph(this.db, job);
  }

  private extractContent(type: string, data: any): string {
    switch (type) {
      case 'session':
        return `${data.title || ''}\n${data.description || ''}`;
      case 'task':
        return data.full_prompt || data.description;
      case 'message':
        return typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
      case 'report':
        return data.content;
      default:
        return '';
    }
  }

  private hash(str: string): string {
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  private async deleteEntity(job: IndexJob) {
    // Remove from embeddings
    await this.db.execute(sql`
      DELETE FROM embeddings
      WHERE entity_type = ${job.entity_type}
        AND entity_id = ${job.entity_id}
    `);

    // Remove from graph (via Cypher)
    await this.db.execute(sql`
      SELECT * FROM cypher('agor_knowledge', $$
        MATCH (n {entity_id: $id})
        DETACH DELETE n
      $$, ${JSON.stringify({ id: job.entity_id })})
    `);
  }
}
```

### Graph Updater

```typescript
// packages/core/src/knowledge-graph/graph-updater.ts

export async function updateGraph(db: Database, job: IndexJob) {
  const { entity_type, entity_id, data } = job;

  switch (entity_type) {
    case 'session':
      await updateSessionGraph(db, entity_id, data);
      break;
    case 'task':
      await updateTaskGraph(db, entity_id, data);
      break;
    // ... more cases
  }
}

async function updateSessionGraph(db: Database, sessionId: string, data: any) {
  // Create/update session node
  await db.execute(sql`
    SELECT * FROM cypher('agor_knowledge', $$
      MERGE (s:Session {id: $id})
      SET s.title = $title,
          s.worktree_id = $worktree_id,
          s.status = $status

      WITH s
      MATCH (w:Worktree {id: $worktree_id})
      MERGE (s)-[:WORKS_ON]->(w)

      ${
        data.parent_session_id
          ? `
        WITH s
        MATCH (parent:Session {id: $parent_id})
        MERGE (s)-[:SPAWNED_FROM]->(parent)
      `
          : ''
      }
    $$, ${JSON.stringify({
      id: sessionId,
      title: data.title,
      worktree_id: data.worktree_id,
      status: data.status,
      parent_id: data.parent_session_id,
    })})
  `);

  // Extract concepts from session content
  const concepts = await extractConcepts(data);
  for (const concept of concepts) {
    await db.execute(sql`
      SELECT * FROM cypher('agor_knowledge', $$
        MERGE (c:Concept {name: $name})
        WITH c
        MATCH (s:Session {id: $session_id})
        MERGE (s)-[:MENTIONS]->(c)
      $$, ${JSON.stringify({ name: concept, session_id: sessionId })})
    `);
  }
}

async function extractConcepts(data: any): Promise<string[]> {
  // Simple keyword extraction (could use NLP/LLM later)
  const text = `${data.title} ${data.description}`.toLowerCase();

  const patterns = [
    /\b(jwt|oauth|authentication|auth)\b/g,
    /\b(redis|postgres|database|db)\b/g,
    /\b(websocket|http|api|rest)\b/g,
    /\b(react|vue|frontend|ui)\b/g,
    /\b(typescript|javascript|node)\b/g,
    /\b(docker|kubernetes|deployment)\b/g,
    /\b(test|testing|jest|vitest)\b/g,
    /\b(migration|schema|drizzle|orm)\b/g,
  ];

  const concepts = new Set<string>();
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(m => concepts.add(m));
    }
  }

  return Array.from(concepts);
}
```

### Feathers Integration

```typescript
// apps/agor-daemon/src/services/sessions.ts

import { KnowledgeGraphIndexer } from '@agor/core/knowledge-graph/indexer';

export class SessionService extends Service<Session> {
  async setup() {
    const indexer = app.get('knowledgeGraphIndexer');

    // Hook into lifecycle events
    this.on('created', async session => {
      // Queue for indexing (non-blocking)
      await indexer.enqueue({
        entity_type: 'session',
        entity_id: session.id,
        operation: 'create',
        worktree_id: session.worktree_id,
        data: session,
      });
    });

    this.on('patched', async session => {
      await indexer.enqueue({
        entity_type: 'session',
        entity_id: session.id,
        operation: 'update',
        worktree_id: session.worktree_id,
        data: session,
      });
    });

    this.on('removed', async session => {
      await indexer.enqueue({
        entity_type: 'session',
        entity_id: session.id,
        operation: 'delete',
        worktree_id: session.worktree_id,
        data: session,
      });
    });
  }
}
```

---

## MCP Tools

Agents interact with the knowledge graph via MCP tools.

### 1. `agor_knowledge_search` (Vector Similarity)

**Description:** Semantic search across sessions, tasks, and messages using vector embeddings.

```typescript
{
  name: "agor_knowledge_search",
  parameters: {
    query: "string - Natural language query",
    worktree_id?: "string - Scope to worktree (default: current)",
    scope?: "'worktree' | 'repo' | 'all' - Search scope",
    entity_types?: "string[] - Filter by ['session', 'task', 'message']",
    limit?: "number - Max results (default: 10)"
  }
}
```

**Example:**

```typescript
agor_knowledge_search({
  query: 'authentication token refresh strategies',
  worktree_id: '019a3af2',
  entity_types: ['session', 'task'],
  limit: 10,
})[
  // Returns:
  ({
    entity_type: 'session',
    entity_id: 'abc123',
    title: 'Implement JWT refresh tokens',
    similarity: 0.92,
    preview: 'Added refresh token rotation with Redis...',
  },
  {
    entity_type: 'task',
    entity_id: 'def456',
    description: 'Fix token expiration handling',
    similarity: 0.87,
    preview: 'Updated auth middleware to check expiry...',
  })
];
```

**Implementation:**

```typescript
async find(params) {
  const { query, worktree_id, entity_types = ['session', 'task'] } = params;

  // 1. Compute query embedding
  const queryEmbedding = await embed(query);

  // 2. Vector similarity search
  return this.db.query(sql`
    SELECT
      entity_type, entity_id, content_preview,
      1 - (embedding <=> ${queryEmbedding}) as similarity
    FROM embeddings
    WHERE worktree_id = ${worktree_id}
      AND entity_type = ANY(${entity_types})
    ORDER BY embedding <=> ${queryEmbedding}
    LIMIT ${params.limit || 10}
  `);
}
```

---

### 2. `agor_knowledge_traverse` (Graph Navigation)

**Description:** Traverse knowledge graph relationships from a starting entity.

```typescript
{
  name: "agor_knowledge_traverse",
  parameters: {
    from_id: "string - Starting entity ID",
    relationship: "string - Relationship type (SPAWNED|EDITED|MENTIONS|SOLVED)",
    direction?: "'outbound' | 'inbound' | 'both' - Traversal direction (default: outbound)",
    depth?: "number - Max hops (default: 2)",
    filters?: "object - Additional filters"
  }
}
```

**Examples:**

**Find files edited by a session:**

```typescript
agor_knowledge_traverse({
  from_id: 'session:abc123',
  relationship: 'EDITED',
  direction: 'outbound',
  depth: 1,
})[
  // Returns:
  ({ type: 'File', id: 'src/auth.ts', path: 'src/auth.ts' },
  { type: 'File', id: 'src/middleware/jwt.ts', path: 'src/middleware/jwt.ts' })
];
```

**Find sessions that edited a file:**

```typescript
agor_knowledge_traverse({
  from_id: 'file:src/auth.ts',
  relationship: 'EDITED',
  direction: 'inbound',
  depth: 1,
});

// Returns sessions that touched src/auth.ts
```

**Find session ancestry:**

```typescript
agor_knowledge_traverse({
  from_id: 'session:abc123',
  relationship: 'SPAWNED_FROM',
  direction: 'outbound',
  depth: 5,
});

// Returns parent/grandparent/etc sessions
```

**Implementation:**

```typescript
async traverse(params) {
  const { from_id, relationship, direction = 'outbound', depth = 2 } = params;

  const directionClause = {
    outbound: '->',
    inbound: '<-',
    both: '-'
  }[direction];

  return this.db.query(sql`
    SELECT * FROM cypher('agor_knowledge', $$
      MATCH path = (start {id: $from_id})
                   -[:${relationship}*1..${depth}]${directionClause}
                   (end)
      RETURN end
    $$, ${JSON.stringify({ from_id })}) as (result agtype)
  `);
}
```

---

### 3. `agor_knowledge_graph_query` (Raw Cypher)

**Description:** Execute custom Cypher queries for advanced graph patterns.

```typescript
{
  name: "agor_knowledge_graph_query",
  parameters: {
    cypher: "string - Cypher query",
    params?: "object - Query parameters"
  }
}
```

**Example: Find sessions with successful spawned children:**

```typescript
agor_knowledge_graph_query({
  cypher: `
    MATCH (parent:Session)-[:SPAWNED]->(child:Session)
    WHERE parent.worktree_id = $worktree_id
      AND child.status = 'completed'
    WITH parent, count(child) as successful_children
    WHERE successful_children > 0
    RETURN parent, successful_children
    ORDER BY successful_children DESC
  `,
  params: { worktree_id: '019a3af2' },
});
```

---

### 4. `agor_knowledge_hybrid_search` (Combined Search)

**Description:** Combine vector similarity with graph constraints for precise results.

```typescript
{
  name: "agor_knowledge_hybrid_search",
  parameters: {
    query: "string - Semantic query",
    worktree_id?: "string - Scope",
    graph_filters?: {
      relationships?: "string[] - Required relationships",
      concepts?: "string[] - Must mention these concepts",
      file_patterns?: "string[] - Must have edited matching files"
    },
    metadata_filters?: {
      status?: "string",
      agentic_tool?: "string",
      date_range?: { from: "string", to: "string" }
    }
  }
}
```

**Example: Find completed sessions about TypeScript errors:**

```typescript
agor_knowledge_hybrid_search({
  query: 'fixing TypeScript type errors',
  worktree_id: '019a3af2',
  graph_filters: {
    concepts: ['TypeScript'],
    file_patterns: ['*.ts'],
  },
  metadata_filters: {
    status: 'completed',
  },
});

// Returns sessions that:
// 1. Are semantically similar to "fixing TypeScript type errors"
// 2. Mention the "TypeScript" concept
// 3. Edited .ts files
// 4. Completed successfully
```

**Implementation:**

```typescript
async hybridSearch(params) {
  const { query, worktree_id, graph_filters, metadata_filters } = params;

  // 1. Vector search (initial candidates)
  const queryEmbedding = await embed(query);
  const vectorResults = await this.db.query(sql`
    SELECT entity_id, 1 - (embedding <=> ${queryEmbedding}) as similarity
    FROM embeddings
    WHERE worktree_id = ${worktree_id}
    ORDER BY similarity DESC
    LIMIT 50
  `);

  const candidateIds = vectorResults.map(r => r.entity_id);

  // 2. Graph filtering
  let graphQuery = `
    MATCH (s:Session)
    WHERE s.id IN $candidate_ids
  `;

  if (graph_filters?.concepts) {
    graphQuery += `
      AND EXISTS {
        MATCH (s)-[:MENTIONS]->(c:Concept)
        WHERE c.name IN $concepts
      }
    `;
  }

  if (graph_filters?.file_patterns) {
    graphQuery += `
      AND EXISTS {
        MATCH (s)-[:EDITED]->(f:File)
        WHERE ${graph_filters.file_patterns.map(p =>
          `f.path =~ '${p.replace('*', '.*')}'`
        ).join(' OR ')}
      }
    `;
  }

  graphQuery += ` RETURN s`;

  const graphResults = await this.db.query(sql`
    SELECT * FROM cypher('agor_knowledge', ${graphQuery}, ${JSON.stringify({
      candidate_ids: candidateIds,
      concepts: graph_filters?.concepts
    })}) as (session agtype)
  `);

  // 3. Metadata filtering
  let results = graphResults;
  if (metadata_filters?.status) {
    results = results.filter(r => r.status === metadata_filters.status);
  }

  // 4. Re-rank by similarity score
  return results
    .map(r => ({
      ...r,
      similarity: vectorResults.find(v => v.entity_id === r.id)?.similarity
    }))
    .sort((a, b) => b.similarity - a.similarity);
}
```

---

### 5. `agor_knowledge_concept_map` (Concept Discovery)

**Description:** Discover concepts and their relationships in a worktree.

```typescript
{
  name: "agor_knowledge_concept_map",
  parameters: {
    worktree_id?: "string - Scope to worktree",
    concept?: "string - Center map on this concept",
    depth?: "number - Relationship hops (default: 2)",
    min_mentions?: "number - Minimum times mentioned (default: 2)"
  }
}
```

**Example: Explore concepts related to "authentication":**

```typescript
agor_knowledge_concept_map({
  concept: "authentication",
  worktree_id: "019a3af2",
  depth: 2,
  min_mentions: 3
})

// Returns:
{
  concepts: [
    { name: "authentication", mention_count: 15 },
    { name: "JWT", mention_count: 12 },
    { name: "OAuth", mention_count: 8 },
    { name: "Redis", mention_count: 6 }
  ],
  relationships: [
    { from: "authentication", to: "JWT", strength: 10, sessions: ["abc", "def"] },
    { from: "authentication", to: "OAuth", strength: 7, sessions: ["ghi"] },
    { from: "JWT", to: "Redis", strength: 4, sessions: ["abc"] }
  ]
}
```

**Implementation:**

```typescript
async conceptMap(params) {
  const { concept, worktree_id, depth = 2, min_mentions = 2 } = params;

  // Find concepts co-mentioned with target concept
  return this.db.query(sql`
    SELECT * FROM cypher('agor_knowledge', $$
      MATCH (start:Concept {name: $concept})
            <-[:MENTIONS]-(s:Session)
            -[:MENTIONS]->(related:Concept)
      WHERE s.worktree_id = $worktree_id
      WITH related, count(DISTINCT s) as mention_count, collect(s.id) as sessions
      WHERE mention_count >= $min_mentions
      RETURN related.name as name, mention_count, sessions
      ORDER BY mention_count DESC
    $$, ${JSON.stringify({ concept, worktree_id, min_mentions })})
    as (name text, mention_count int, sessions text[])
  `);
}
```

---

### 6. `agor_knowledge_find_similar_sessions` (Session Comparison)

**Description:** Find sessions similar to a given session based on multiple factors.

```typescript
{
  name: "agor_knowledge_find_similar_sessions",
  parameters: {
    session_id: "string - Reference session",
    similarity_aspects?: "string[] - ['content', 'files_edited', 'concepts', 'structure']",
    limit?: "number - Max results (default: 5)"
  }
}
```

**Example:**

```typescript
agor_knowledge_find_similar_sessions({
  session_id: 'abc123',
  similarity_aspects: ['files_edited', 'concepts'],
  limit: 5,
});

// Returns sessions that:
// 1. Edited overlapping files
// 2. Mentioned similar concepts
// Combined and ranked by similarity score
```

---

## Hybrid Query Patterns

### Pattern 1: "Find then Explore"

Agent starts with semantic search, then explores relationships:

```typescript
// Step 1: Find relevant sessions
const sessions = await agor_knowledge_search({
  query: 'vector databases',
  worktree_id: '019a3af2',
  limit: 10,
});

// Step 2: Explore what files they touched
const files = await agor_knowledge_traverse({
  from_id: sessions[0].id,
  relationship: 'EDITED',
  direction: 'outbound',
});

// Step 3: Find other sessions that touched same files
const relatedSessions = await agor_knowledge_traverse({
  from_id: files[0].id,
  relationship: 'EDITED',
  direction: 'inbound',
});
```

**Agent reasoning:**

- "Let me search for sessions about vector databases"
- "Found 3 sessions. Let me see what files they touched"
- "Interesting, they edited db/schema.ts. Who else touched that file?"
- "Now I have the full picture of all vector DB work"

---

### Pattern 2: "Explore then Filter"

Agent uses graph structure, then filters by semantic relevance:

```typescript
// Step 1: Find all descendants
const descendants = await agor_knowledge_traverse({
  from_id: 'parent-session',
  relationship: 'SPAWNED',
  direction: 'outbound',
  depth: 3,
});

// Step 2: Filter to only those about authentication
const filtered = await agor_knowledge_search({
  query: 'authentication JWT tokens',
  entity_ids: descendants.map(d => d.id), // Pre-filtered set
  min_similarity: 0.7,
});
```

---

### Pattern 3: "Concept Clustering"

Agent discovers implicit relationships through concepts:

```typescript
// Step 1: Find concepts related to WebSocket
const conceptMap = await agor_knowledge_concept_map({
  concept: 'WebSocket',
  worktree_id: '019a3af2',
  min_mentions: 2,
});

// Returns: WebSocket often mentioned with Redis (6 sessions)

// Step 2: Find those sessions
const sessions = await agor_knowledge_hybrid_search({
  query: 'WebSocket Redis real-time',
  graph_filters: {
    concepts: ['WebSocket', 'Redis'],
  },
});
```

---

### Pattern 4: "Similarity + Constraints"

Vector search with graph filters:

```typescript
const results = await agor_knowledge_hybrid_search({
  query: 'database migration schema changes',
  worktree_id: '019a3af2',
  graph_filters: {
    relationships: ['SOLVED'], // Only sessions that solved problems
    file_patterns: ['*.sql', 'migrations/*'],
  },
  metadata_filters: {
    status: 'completed',
  },
});

// Returns: Completed sessions about migrations that solved problems
```

---

## Example Agent Workflow

**User:** "I need to add Redis caching. Show me what's been done before."

**Agent reasoning:**

```typescript
// Step 1: Semantic search
const sessions = await agor_knowledge_search({
  query: "Redis caching implementation",
  worktree_id: current_worktree,
  limit: 5
});

// Returns:
// - Session A: "Add Redis for session storage" (0.89 similarity)
// - Session B: "Implement cache layer" (0.82 similarity)
// - Session C: "Fix Redis connection pooling" (0.78 similarity)

// Step 2: Find files they touched
const filesA = await agor_knowledge_traverse({
  from_id: sessions[0].id,
  relationship: "EDITED",
  direction: "outbound"
});

// Returns:
// - src/cache/redis.ts
// - src/config/redis.ts
// - docker-compose.yml

// Step 3: Find other sessions that touched same files
const relatedSessions = await agor_knowledge_traverse({
  from_id: "file:src/cache/redis.ts",
  relationship: "EDITED",
  direction: "inbound",
  depth: 1
});

// Returns 3 more sessions that touched redis.ts

// Step 4: Check if any had problems
const problems = await agor_knowledge_graph_query({
  cypher: `
    MATCH (s:Session)-[:EDITED]->(f:File {path: 'src/cache/redis.ts'})
    OPTIONAL MATCH (s)-[:ENCOUNTERED]->(p:Problem)
    RETURN s, collect(p) as problems
  `,
  params: {}
});

// Agent response:
"I found 5 sessions that worked on Redis caching:

1. **Session A** (most relevant, 0.89 similarity)
   - Added Redis session storage
   - Edited: src/cache/redis.ts, docker-compose.yml
   - Status: Completed successfully

2. **Session C** (0.78 similarity)
   - Fixed connection pooling issues
   - Problem: Redis connections not closing
   - Solution: Implemented connection pool with max size

Based on this, I recommend:
- Look at Session A's implementation in src/cache/redis.ts
- Be aware of Session C's pooling issues
- Consider using the docker-compose setup from Session A

Want me to open those files?"
```

---

## Implementation Phases

### Phase 1: Foundation (Postgres + Schema)

- [ ] Add Postgres support to Agor (alongside SQLite)
- [ ] Create migrations for AGE + pgvector extensions
- [ ] Create `embeddings` and `index_queue` tables
- [ ] Build basic embedding service (OpenAI API)

### Phase 2: Background Indexer

- [ ] Implement `KnowledgeGraphIndexer` class
- [ ] Hook into Feathers service events (created/patched/removed)
- [ ] Build job queue processor (polling + batch processing)
- [ ] Add concept extraction (regex-based, simple)

### Phase 3: MCP Tools (Core)

- [ ] `agor_knowledge_search` - Vector similarity search
- [ ] `agor_knowledge_traverse` - Graph navigation
- [ ] Test with agents using both tools

### Phase 4: MCP Tools (Advanced)

- [ ] `agor_knowledge_hybrid_search` - Combined queries
- [ ] `agor_knowledge_concept_map` - Concept discovery
- [ ] `agor_knowledge_graph_query` - Raw Cypher access

### Phase 5: UI & Polish

- [ ] Search UI in Agor (global search bar)
- [ ] Visualize knowledge graph (React Flow?)
- [ ] Index status dashboard (queue depth, indexing rate)
- [ ] Backfill tool for existing data

### Phase 6: Optimization

- [ ] Batch embedding API calls (OpenAI batch API)
- [ ] Local embeddings (sentence-transformers, no API cost)
- [ ] Smart chunking for long content
- [ ] LLM-powered concept extraction (replace regex)

---

## Open Questions

### 1. Embedding Model Choice

- **OpenAI ada-002:** Simple API, proven, costs ~$0.10/1M tokens
- **Local (sentence-transformers):** Free, privacy, slower, less accurate
- **Hybrid:** Use local for dev, OpenAI for prod?

**Recommendation:** Start with OpenAI, add local option later.

### 2. Concept Extraction Strategy

- **Regex patterns:** Fast, deterministic, limited
- **NLP (spaCy):** Better, requires Python bridge
- **LLM (GPT-4o-mini):** Best quality, costs money, slower
- **Hybrid:** Regex + LLM for important entities?

**Recommendation:** Start with regex, upgrade to LLM later.

### 3. Archive vs Delete

- Currently: Delete session → gone forever
- With KG: Soft delete → remove from board, keep in graph?
- Privacy concerns: How long to keep embeddings?

**Recommendation:** Add `archived` flag to sessions, keep in graph but hide from UI.

### 4. Search Scope Permissions

- Can agents search other users' sessions?
- Team-scoped vs user-scoped knowledge graphs?
- Privacy modes: "Share my learnings" vs "Private work"?

**Recommendation:** Start with worktree-scoped (all sessions in worktree searchable), add privacy later.

### 5. Performance at Scale

- How many sessions before graph queries slow down?
- Index maintenance costs?
- When to prune old embeddings?

**Recommendation:** Profile with 10k+ sessions, optimize if needed.

---

## Success Metrics

**Indexing Performance:**

- Queue processing rate: >50 jobs/sec
- Embedding latency: <500ms per entity
- Index lag: <5 minutes from entity creation to searchable

**Search Quality:**

- Relevance: Top-3 results useful >80% of time
- Graph traversal: <100ms for 2-hop queries
- Hybrid search: Improves precision by >30% vs vector-only

**Agent Adoption:**

- > 50% of spawned sessions use knowledge search
- Agents discover related work before starting (reduces duplication)
- Session quality improves (measured by success rate)

---

## Related Work

**Similar systems:**

- **Anthropic's Workbench:** Context management, but no graph
- **Cursor/Copilot:** Code search, but no session history
- **LangChain/LlamaIndex:** RAG frameworks, but not integrated into dev tools

**Novel aspects:**

- Session-centric knowledge graph (not just code)
- Background indexing (doesn't block user)
- Hybrid vector + graph (best of both worlds)
- Agent-accessible via MCP (self-discovery)

---

## Next Steps

1. **Validate with prototype:** Build minimal version (OpenAI embeddings + simple graph)
2. **User testing:** Give to early adopters, measure if agents actually use it
3. **Iterate on query patterns:** What hybrid queries are most useful?
4. **Decide on concept extraction:** Regex sufficient or need LLM?
5. **Plan Postgres migration:** How to make PG adoption smooth for users?

---

**Status:** Ready for prototype implementation
**Owner:** TBD
**Target:** v0.6.0 (Postgres + Knowledge Graph feature)
