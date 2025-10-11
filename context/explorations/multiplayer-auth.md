# Cloud Multiplayer Authentication (Phase 3)

**Status:** Partially Implemented / Future Planning
**Related:** [../concepts/auth.md](../concepts/auth.md), [../concepts/architecture.md](../concepts/architecture.md)

## Implementation Status

**✅ Phase 2 Complete (Multi-User Foundation):**

- User accounts with email/password authentication
- JWT token management with persistent secrets
- Real-time WebSocket sync for board positions
- User attribution (created_by tracking)
- User profiles with emoji avatars
- Multi-user board collaboration

**📋 Phase 3 Remaining (Enterprise Features):**

- OAuth providers (GitHub, Google, OIDC/SAML)
- Organizations/teams (multi-tenancy)
- Role-based permissions (CASL integration)
- Cloud deployment (PostgreSQL migration)
- Session sharing (board-level permissions)
- API tokens (CI/CD automation)

See [../concepts/auth.md](../concepts/auth.md) for current implementation details.

This document explores Phase 3 features still to be implemented.

---

## Goal

Enable secure multi-user collaboration in cloud-hosted Agor deployments with:

1. **OAuth providers** - GitHub, Google, generic OIDC/SAML
2. **Organizations** - Team workspaces with member management
3. **Role-based permissions** - Fine-grained access control
4. **Session sharing** - Board-level visibility controls
5. **API tokens** - Programmatic access for automation

---

## Architecture Changes

### From Local SQLite → Cloud PostgreSQL

**Current (V2):**

```
Local machine → SQLite (~/.agor/agor.db) → Anonymous or basic auth
```

**Future (V3):**

```
Multiple users → PostgreSQL (Turso/Supabase) → OAuth + RBAC
```

**Migration Strategy:**

- Export local data: `agor export --output backup.json`
- Deploy PostgreSQL: `agor cloud deploy --provider turso`
- Import data: `agor import --input backup.json --db $DATABASE_URL`

---

## Data Model Extensions

### Organizations Table

```typescript
export const organizations = pgTable('organizations', {
  org_id: text('org_id').primaryKey(),
  created_at: timestamp('created_at').defaultNow(),

  // Materialized
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  owner_id: text('owner_id').references(() => users.user_id),

  // JSON blob
  data: jsonb('data').$type<{
    description?: string;
    avatar?: string;
    settings?: {
      defaultVisibility?: 'private' | 'team' | 'public';
      allowGuestAccess?: boolean;
    };
  }>(),
});
```

### Organization Members

```typescript
export const organizationMembers = pgTable('organization_members', {
  org_id: text('org_id').references(() => organizations.org_id),
  user_id: text('user_id').references(() => users.user_id),
  role: text('role', {
    enum: ['owner', 'admin', 'member', 'viewer'],
  }).notNull(),
  joined_at: timestamp('joined_at').defaultNow(),
});
```

### Session Visibility & Ownership

```typescript
// Add to sessions table
{
  owner_id: text('owner_id').references(() => users.user_id),
  org_id: text('org_id').references(() => organizations.org_id),
  visibility: text('visibility', {
    enum: ['private', 'team', 'public']
  }).default('private'),
}
```

**Visibility Rules:**

- `private`: Only owner can access
- `team`: All org members can access
- `public`: Anyone with link can view (read-only)

---

## OAuth Integration

### Providers

**Supported via FeathersJS OAuth:**

- GitHub
- Google
- Generic OIDC (custom identity providers)
- SAML (enterprise)

### Implementation

```typescript
import { OAuthStrategy } from '@feathersjs/authentication-oauth';

class GitHubStrategy extends OAuthStrategy {
  async getEntityData(profile) {
    return {
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar_url,
      githubId: profile.id,
    };
  }
}

authentication.register('github', new GitHubStrategy());
authentication.register('google', new GoogleStrategy());
```

### OAuth Flow

```
1. User clicks "Login with GitHub"
2. Redirect to GitHub OAuth
3. GitHub redirects back with code
4. Exchange code for profile
5. Create or update user record
6. Issue JWT token
7. Return to app
```

### Configuration

```yaml
daemon:
  oauth:
    github:
      clientId: env:GITHUB_CLIENT_ID
      clientSecret: env:GITHUB_CLIENT_SECRET
      callbackURL: https://app.agor.dev/auth/github/callback
    google:
      clientId: env:GOOGLE_CLIENT_ID
      clientSecret: env:GOOGLE_CLIENT_SECRET
      callbackURL: https://app.agor.dev/auth/google/callback
```

---

## Role-Based Permissions (RBAC)

### Permission System with CASL

**Library:** [@casl/ability](https://casl.js.org/)

**Roles:**

- `owner`: Full control (delete org, manage billing)
- `admin`: Manage members, sessions, boards
- `member`: Create sessions, edit own sessions
- `viewer`: Read-only access to team content

### Ability Definitions

```typescript
import { AbilityBuilder, createMongoAbility } from '@casl/ability';

export function defineAbilitiesFor(user, orgRole) {
  const { can, cannot, build } = new AbilityBuilder(createMongoAbility);

  // Anonymous users (local mode compatibility)
  if (user.role === 'admin' && user.id === 'anonymous') {
    can('manage', 'all');
    return build();
  }

  // Public content (anyone can read)
  can('read', 'Session', { visibility: 'public' });

  // Own content (full control)
  can('manage', 'Session', { owner_id: user.id });

  // Organization content (based on role)
  if (orgRole === 'owner' || orgRole === 'admin') {
    can('manage', 'Session', { org_id: user.org_id });
    can('manage', 'Board', { org_id: user.org_id });
    can('manage', 'OrganizationMember', { org_id: user.org_id });
  }

  if (orgRole === 'member') {
    can('read', 'Session', { org_id: user.org_id, visibility: 'team' });
    can('create', 'Session');
    can('update', 'Session', { owner_id: user.id });
  }

  if (orgRole === 'viewer') {
    can('read', 'Session', { org_id: user.org_id, visibility: 'team' });
    cannot('create', 'Session');
    cannot('update', 'Session');
  }

  return build();
}
```

### FeathersJS Hook Integration

```typescript
import { defineAbilitiesFor } from '@agor/core/permissions';
import { Forbidden } from '@feathersjs/errors';

export const authorize = (action, subject) => async context => {
  const { user } = context.params;

  // Load org membership
  const membership = await getOrgMembership(user.id);
  const ability = defineAbilitiesFor(user, membership?.role);

  if (!ability.can(action, subject)) {
    throw new Forbidden(`You cannot ${action} ${subject}`);
  }

  return context;
};

// Apply to services
export const sessionHooks = {
  before: {
    create: [authenticate('jwt'), authorize('create', 'Session')],
    update: [authenticate('jwt'), authorize('update', 'Session')],
    remove: [authenticate('jwt'), authorize('delete', 'Session')],
  },
};
```

### Query Filtering by Permissions

```typescript
// Automatically filter queries based on permissions
app.service('sessions').hooks({
  before: {
    find: [
      async context => {
        const { user } = context.params;
        const membership = await getOrgMembership(user.id);

        // Build query based on what user can access
        context.params.query = {
          $or: [
            { owner_id: user.id }, // Own sessions
            { org_id: membership.org_id, visibility: 'team' }, // Team sessions
            { visibility: 'public' }, // Public sessions
          ],
        };

        return context;
      },
    ],
  },
});
```

---

## API Tokens for Automation

### Use Cases

- CI/CD pipelines creating sessions
- Scripted session analysis
- Third-party integrations

### Token Types

**Personal Access Tokens (PATs):**

- User-scoped
- Long-lived (30-90 days)
- Revocable

**Organization API Keys:**

- Org-scoped
- Role-based (read-only, read-write, admin)
- Multiple keys per org

### Implementation

```typescript
export const apiTokens = pgTable('api_tokens', {
  token_id: text('token_id').primaryKey(),
  user_id: text('user_id').references(() => users.user_id),
  org_id: text('org_id').references(() => organizations.org_id),

  name: text('name').notNull(), // "CI Pipeline Token"
  token_hash: text('token_hash').notNull(), // bcrypt hash

  scopes: text('scopes', { mode: 'json' }).$type<string[]>(), // ['sessions:read', 'boards:write']

  last_used_at: timestamp('last_used_at'),
  expires_at: timestamp('expires_at'),
  created_at: timestamp('created_at').defaultNow(),
});
```

### Usage

```bash
# Create PAT
$ agor auth token create --name "CI Pipeline" --expires 90d
✓ Token created: agor_pat_abc123xyz...
⚠️  Save this token securely - it won't be shown again

# Use token
$ curl -H "Authorization: Bearer agor_pat_abc123xyz..." \
  https://api.agor.dev/sessions
```

---

## Session Sharing

### Share Session via Link

```bash
# Generate shareable link
$ agor session share <session-id> --visibility public
✓ Session shared: https://agor.dev/s/abc123

# Revoke public access
$ agor session share <session-id> --visibility private
```

### Board-Level Sharing

```typescript
// Share entire board with team
await boardsService.patch(boardId, {
  visibility: 'team',
  org_id: orgId,
});

// All sessions on board inherit visibility
```

---

## Migration Checklist

### Database

- [ ] Migrate schema from SQLite → PostgreSQL
- [ ] Create organizations table
- [ ] Create organization_members table
- [ ] Add `owner_id`, `org_id`, `visibility` to sessions/boards
- [ ] Create api_tokens table

### Authentication

- [ ] Configure OAuth providers (GitHub, Google)
- [ ] Test OAuth flow end-to-end
- [ ] Implement generic OIDC strategy
- [ ] Add SAML support (enterprise)

### Permissions

- [ ] Integrate CASL for ability definitions
- [ ] Add authorization hooks to all services
- [ ] Implement query filtering by permissions
- [ ] Test permission edge cases

### API Tokens

- [ ] Implement token generation
- [ ] Add token validation middleware
- [ ] Create token management UI
- [ ] Add token revocation

### Organizations

- [ ] Organization creation flow
- [ ] Member invitation system
- [ ] Role management UI
- [ ] Billing integration (future)

### UI

- [ ] OAuth login buttons
- [ ] Organization switcher
- [ ] Member management page
- [ ] Session sharing controls
- [ ] API token management

---

## Security Considerations

### OAuth Security

- Use state parameter to prevent CSRF
- Validate redirect URLs
- Store OAuth tokens securely (encrypted at rest)
- Implement token refresh flow

### API Token Security

- Hash tokens with bcrypt before storage
- Show token only once at creation
- Support token revocation
- Implement rate limiting per token
- Log token usage for audit

### Permission System

- Default deny (whitelist approach)
- Validate permissions on every request
- Filter queries by permissions (don't rely on client)
- Audit permission changes

### PostgreSQL Security

- Use SSL/TLS for connections
- Rotate database credentials
- Implement row-level security (RLS) policies
- Regular backups with encryption

---

## Cost Estimates

### Infrastructure (Cloud Deployment)

**Database (Turso/Supabase):**

- Free tier: 500 MB, 1B row reads/month
- Pro tier: $25/month (10 GB, 10B row reads)

**Hosting (Railway/Fly.io):**

- Daemon: ~$5/month (256MB RAM)
- UI: Static hosting free (Vercel/Netlify)

**OAuth (Free):**

- GitHub/Google OAuth: Free
- Custom OIDC: Depends on provider

**Total:** ~$30-50/month for small team (<10 users)

### Development Time Estimate

- Organizations + OAuth: 2-3 weeks
- RBAC with CASL: 1-2 weeks
- API tokens: 1 week
- UI for team management: 1-2 weeks
- Testing + polish: 1 week

**Total:** ~6-9 weeks for Phase 3

---

## Open Questions

1. **Workspace vs Organization terminology?**
   - Recommendation: "Organization" (aligns with GitHub)

2. **Session sharing granularity?**
   - Share individual sessions or entire boards?
   - Recommendation: Board-level (simpler permissions)

3. **Guest access for public sessions?**
   - Allow unauthenticated viewing?
   - Recommendation: Yes (read-only public links)

4. **Billing integration?**
   - Stripe for paid plans?
   - Recommendation: Defer until user validation

5. **Multi-org support?**
   - Can users belong to multiple orgs?
   - Recommendation: Yes (like GitHub)

---

## Related Documents

- [../concepts/auth.md](../concepts/auth.md) - Current authentication implementation
- [../concepts/architecture.md](../concepts/architecture.md) - System architecture
- [../concepts/models.md](../concepts/models.md) - Data models

---

## References

**External:**

- [FeathersJS OAuth](https://feathersjs.com/api/authentication/oauth)
- [CASL (Authorization)](https://casl.js.org/)
- [Turso (Database)](https://turso.tech/)
- [Better Auth](https://www.better-auth.com/) - Alternative auth library
