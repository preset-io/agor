# Auto-Generated API Documentation

**Status:** Proposed
**Created:** 2025-01-27

## Problem

The current API reference (`/apps/agor-docs/pages/api-reference/`) is static MDX that:

- Gets out of sync with actual API endpoints
- Requires manual updates whenever services change
- Duplicates information already in TypeScript types
- Doesn't provide interactive testing

## Solution: feathers-swagger Integration

Use the `feathers-swagger` package to auto-generate OpenAPI documentation from Feathers services.

### Benefits

1. **Always up-to-date** - Generated from actual service definitions
2. **Interactive** - Swagger UI lets users try endpoints in-browser
3. **Zero maintenance** - No manual docs to update
4. **Standards-compliant** - OpenAPI 3.0 spec
5. **TypeScript integration** - Can leverage existing type definitions

## Implementation Plan

### Phase 1: Add feathers-swagger to Daemon

**Files to modify:**

- `apps/agor-daemon/package.json` - Add dependency
- `apps/agor-daemon/src/index.ts` - Configure swagger middleware

**Basic configuration:**

```typescript
import swagger from 'feathers-swagger';

app.configure(
  swagger({
    openApiVersion: 3,
    docsPath: '/docs',
    docsJsonPath: '/docs.json',
    uiIndex: true, // Enable Swagger UI
    specs: {
      info: {
        title: 'Agor API',
        description: 'REST and WebSocket API for Agor agent orchestration platform',
        version: '0.4.0',
      },
      servers: [{ url: 'http://localhost:3030', description: 'Local development' }],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  })
);
```

### Phase 2: Add Service Documentation

Enhance each service with OpenAPI schemas:

**Example for sessions service:**

```typescript
// apps/agor-daemon/src/services/sessions/sessions.ts
export const sessionsServiceDocs = {
  description: 'AI agent session management with genealogy (fork/spawn)',
  definitions: {
    sessions: {
      type: 'object',
      required: ['session_id', 'worktree_id', 'agentic_tool'],
      properties: {
        session_id: { type: 'string', format: 'uuid', description: 'Unique session identifier' },
        worktree_id: { type: 'string', format: 'uuid', description: 'Associated worktree' },
        agentic_tool: {
          type: 'string',
          enum: ['claude', 'codex', 'gemini'],
          description: 'Agent type',
        },
        status: { type: 'string', enum: ['idle', 'running', 'completed', 'failed'] },
        title: { type: 'string' },
        // ... more fields
      },
    },
  },
  find: {
    description: 'List all sessions with optional filtering',
    parameters: [
      { name: '$limit', in: 'query', type: 'integer', description: 'Max results' },
      { name: '$skip', in: 'query', type: 'integer', description: 'Pagination offset' },
      { name: 'status', in: 'query', type: 'string', description: 'Filter by status' },
    ],
  },
  create: {
    description: 'Create a new session',
  },
  // ... other methods
};

// Add to service registration
app.use('sessions', new SessionsService(), {
  docs: sessionsServiceDocs,
});
```

### Phase 3: Embed API Docs in Documentation Site

**Goal:** Make the API reference available in the docs site for agents/LLMs to learn from.

**Option A: Embed Swagger UI Component**

Use a React component like `swagger-ui-react` in the docs site:

```bash
cd apps/agor-docs
pnpm add swagger-ui-react
```

**Create interactive docs page:**

```typescript
// apps/agor-docs/pages/api-reference/index.tsx
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';

export default function APIReference() {
  return (
    <div>
      <h1>API Reference</h1>
      <p>Interactive REST API documentation auto-generated from the daemon.</p>
      <SwaggerUI url="http://localhost:3030/docs.json" />
    </div>
  );
}
```

**Option B: Build-Time Generation (Better for LLMs)**

Generate static API docs during build:

1. **Fetch OpenAPI spec at build time**
2. **Convert to MDX** using a tool or custom script
3. **Commit generated docs** so they're in the repo for LLMs

```bash
# Build script
curl http://localhost:3030/docs.json > apps/agor-docs/public/openapi.json
# Convert OpenAPI to MDX (using a tool like openapi-to-mdx)
openapi-to-mdx public/openapi.json --output pages/api-reference/generated/
```

**Option C: Hybrid Approach (Recommended)**

1. **Static MDX overview** - Keep a hand-written index explaining patterns
2. **Embedded OpenAPI spec** - Include the full spec as JSON in the docs
3. **Interactive viewer** - Embed Swagger UI for human use
4. **Markdown generation** - Auto-generate detailed endpoint docs for LLM consumption

**Files to update:**

- `apps/agor-docs/pages/api-reference/index.mdx` - Overview and patterns
- `apps/agor-docs/pages/api-reference/rest.mdx` - Auto-generated from OpenAPI
- `apps/agor-docs/pages/api-reference/websockets.mdx` - Keep manual (not in OpenAPI)
- `apps/agor-docs/public/openapi.json` - Full spec for reference

**Example generated content:**

```markdown
# REST API Endpoints

Auto-generated from OpenAPI specification.

## Sessions

### `GET /sessions`

List all sessions with optional filtering.

**Query Parameters:**

- `$limit` (integer) - Max results (default: 50)
- `$skip` (integer) - Pagination offset
- `status` (string) - Filter by status: `idle`, `running`, `completed`, `failed`

**Response Schema:**
\`\`\`json
{
"data": [
{
"session_id": "string (uuid)",
"worktree_id": "string (uuid)",
"agentic_tool": "claude | codex | gemini",
"status": "idle | running | completed | failed",
"title": "string"
}
],
"total": 100,
"limit": 50,
"skip": 0
}
\`\`\`
```

### Phase 4: Documentation Updates

Update references in guide pages:

- `apps/agor-docs/pages/guide/architecture.mdx` - Update API reference link
- `apps/agor-docs/pages/guide/development.mdx` - Update API reference link
- `apps/agor-docs/pages/guide/getting-started.mdx` - Mention `/docs` endpoint

## Open Questions

1. **Service-level docs** - How detailed should we document each method? Start minimal and expand?
2. **WebSocket events** - feathers-swagger covers REST, but what about WebSocket? Keep minimal WebSocket docs?
3. **Custom endpoints** - Handle special endpoints like `/sessions/:id/prompt`?
4. **Examples** - Should we add example requests/responses to service docs?

## Alternative: Type-Driven Generation

If feathers-swagger is insufficient, we could:

1. Use Drizzle schema + TypeScript types to generate OpenAPI
2. Build custom doc generation from `packages/core/src/types`
3. Use tools like `typedoc` or `api-extractor`

## Next Steps

1. ✅ Document the plan (this file)
2. ⬜ Prototype feathers-swagger integration in daemon
3. ⬜ Test with one service (sessions)
4. ⬜ Verify Swagger UI works at `/docs`
5. ⬜ Document all services with schemas
6. ⬜ Remove static API docs
7. ⬜ Update guide references

## References

- [feathers-swagger](https://github.com/feathersjs-ecosystem/feathers-swagger)
- [OpenAPI 3.0 Spec](https://swagger.io/specification/)
- [Swagger UI](https://swagger.io/tools/swagger-ui/)
