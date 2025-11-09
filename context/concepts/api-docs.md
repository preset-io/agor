# Auto API Docs

**Status:** ✅ Implemented (Feb 2025)
**Related:** [[architecture]], [[auth]]

---

## Overview

The daemon now generates an OpenAPI 3 spec and interactive Swagger UI automatically from registered Feathers services. Every service call defines its JSON schema once, and docs stay in sync with runtime behavior.

- **Swagger UI:** `http://localhost:3030/docs`
- **Raw spec:** `http://localhost:3030/docs.json`
- **Security:** All endpoints require Bearer auth except `/health` and `/login`.

## Implementation

- Configured via `app.configure(swagger({...}))` inside `apps/agor-daemon/src/index.ts`.
- Service-level schemas are declared inline when calling `app.use('/service', service, { docs: {...} })` so definitions live next to implementation.
- CLI + UI reuse the same spec for type-safe clients.

## Usage Tips

- Hit `/docs` while daemon is running to explore endpoints and example payloads.
- Use the spec for generating strongly typed API clients or for external integrations.
- When adding a new service, include a `docs` object so it appears automatically.

_Background research lives in `context/archives/auto-generated-api-docs.md`._
