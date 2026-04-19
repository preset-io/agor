/**
 * MCP token module tests.
 *
 * Exercises the issue → verify cycle against an in-memory SQLite database.
 * A minimal repo/worktree/session fixture is seeded so the session-existence
 * check in validate has something to read.
 *
 * Coverage:
 *   - minted tokens carry `jti` + `exp` (+ `iat`, `iss`, `aud`) claims
 *   - expired token → rejected
 *   - deleted session → token rejected (even before `exp`)
 *   - bogus issuer → rejected
 *   - pre-rollout tokens (no jti/exp) → rejected
 */

import {
  type Database,
  deleteFrom,
  eq,
  generateId,
  insert,
  RepoRepository,
  sessions,
  worktrees,
} from '@agor/core/db';
import type { SessionID, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  generateSessionToken,
  initMcpTokens,
  MCP_TOKEN_AUDIENCE,
  MCP_TOKEN_ISSUER,
  shutdownMcpTokens,
  validateSessionToken,
} from './tokens.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-jwt-secret-do-not-use-in-production';

/**
 * Build a minimal `app` stub that exposes `settings.authentication.secret` —
 * the only thing the token module reads off the Feathers application.
 */
// biome-ignore lint/suspicious/noExplicitAny: test harness
function makeApp(): any {
  return { settings: { authentication: { secret: JWT_SECRET } } };
}

async function seedSession(
  db: Database,
  opts: { sessionId: SessionID } = { sessionId: generateId() as SessionID }
): Promise<SessionID> {
  const repoRepo = new RepoRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `slug-${opts.sessionId.slice(0, 8)}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/test.git',
    local_path: '/tmp/test',
    default_branch: 'main',
  });

  const worktreeId = generateId();
  await insert(db, worktrees)
    .values({
      worktree_id: worktreeId,
      repo_id: repo.repo_id,
      created_at: new Date(),
      name: 'main',
      ref: 'main',
      worktree_unique_id: 1,
      data: { path: '/tmp/test/wt', git_state: { ref_at_start: 'main' } },
    })
    .run();

  await insert(db, sessions)
    .values({
      session_id: opts.sessionId,
      created_at: new Date(),
      status: 'idle',
      agentic_tool: 'claude-code',
      worktree_id: worktreeId,
      created_by: 'anonymous',
      data: { genealogy: { children: [] }, contextFiles: [], tasks: [], git_state: {} },
    })
    .run();

  return opts.sessionId;
}

afterEach(() => {
  shutdownMcpTokens();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

describe('generateSessionToken', () => {
  dbTest('issues a token with jti, exp, iat, aud, iss claims', async ({ db }) => {
    initMcpTokens({ db, expirationMs: 60_000 });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const app = makeApp();

    const token = await generateSessionToken(app, sessionId, 'user-1' as UserID);

    const decoded = jwt.verify(token, JWT_SECRET, {
      audience: MCP_TOKEN_AUDIENCE,
    }) as Record<string, unknown>;

    expect(decoded.sub).toBe(sessionId);
    expect(decoded.uid).toBe('user-1');
    expect(decoded.aud).toBe(MCP_TOKEN_AUDIENCE);
    expect(decoded.iss).toBe(MCP_TOKEN_ISSUER);
    expect(typeof decoded.jti).toBe('string');
    expect((decoded.jti as string).length).toBeGreaterThan(0);
    expect(typeof decoded.iat).toBe('number');
    expect(typeof decoded.exp).toBe('number');
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(60);
  });

  dbTest('each issuance produces a different jti', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });

    const t1 = await generateSessionToken(makeApp(), sessionId, 'u' as UserID);
    const t2 = await generateSessionToken(makeApp(), sessionId, 'u' as UserID);
    const d1 = jwt.decode(t1) as { jti?: string };
    const d2 = jwt.decode(t2) as { jti?: string };

    expect(d1.jti).toBeDefined();
    expect(d2.jti).toBeDefined();
    expect(d1.jti).not.toBe(d2.jti);
  });

  dbTest('throws when the session does not exist', async ({ db }) => {
    initMcpTokens({ db });
    const missingSessionId = generateId() as SessionID;
    await expect(generateSessionToken(makeApp(), missingSessionId, 'u1' as UserID)).rejects.toThrow(
      /not found/
    );
  });
});

// ---------------------------------------------------------------------------
// Validation — happy path, expiry, session-deletion, issuer check
// ---------------------------------------------------------------------------

describe('validateSessionToken', () => {
  dbTest('accepts a freshly minted token', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const token = await generateSessionToken(makeApp(), sessionId, 'u1' as UserID);

    const ctx = await validateSessionToken(makeApp(), token);
    expect(ctx).not.toBeNull();
    expect(ctx?.sessionId).toBe(sessionId);
    expect(ctx?.userId).toBe('u1');
    expect(typeof ctx?.jti).toBe('string');
  });

  dbTest('rejects a token whose exp has passed', async ({ db }) => {
    // Fake timers let us fast-forward past the 60s expiry without waiting —
    // `jsonwebtoken.verify` reads `Date.now()` for exp checks, so we must
    // stub the global clock (injecting `now` into the module alone isn't
    // enough because verify uses the system clock directly).
    const baseMs = Date.now();
    vi.useFakeTimers({ now: baseMs, shouldAdvanceTime: false });
    try {
      initMcpTokens({ db, expirationMs: 60_000 });
      const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
      const token = await generateSessionToken(makeApp(), sessionId, 'u1' as UserID);

      // Still valid right after issuance.
      expect(await validateSessionToken(makeApp(), token)).not.toBeNull();

      // Step past the 60s expiry plus some slack.
      vi.setSystemTime(new Date(baseMs + 120_000));
      const result = await validateSessionToken(makeApp(), token);
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  dbTest('rejects tokens for sessions that have been deleted', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const token = await generateSessionToken(makeApp(), sessionId, 'u1' as UserID);

    // Simulate the session being deleted out from under us.
    await deleteFrom(db, sessions).where(eq(sessions.session_id, sessionId)).run();

    const result = await validateSessionToken(makeApp(), token);
    expect(result).toBeNull();
  });

  dbTest('rejects a post-rollout token with the wrong issuer', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });

    // Hand-mint a token that has every other claim right but a bogus `iss`.
    const nowSec = Math.floor(Date.now() / 1000);
    const forged = jwt.sign(
      {
        sub: sessionId,
        uid: 'u1',
        aud: MCP_TOKEN_AUDIENCE,
        iss: 'not-agor',
        iat: nowSec,
        exp: nowSec + 60,
        jti: generateId(),
      },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );

    expect(await validateSessionToken(makeApp(), forged)).toBeNull();
  });

  dbTest('rejects a pre-rollout token missing jti/exp', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });

    // Pre-rollout tokens were minted without `jti` or `exp` (and no `iss`).
    const legacy = jwt.sign(
      {
        sub: sessionId,
        uid: 'u1',
        aud: MCP_TOKEN_AUDIENCE,
      },
      JWT_SECRET,
      { algorithm: 'HS256', noTimestamp: true }
    );

    expect(await validateSessionToken(makeApp(), legacy)).toBeNull();
  });

  dbTest('rejects a signature-valid token that has a jti but is missing exp', async ({ db }) => {
    // Belt-and-suspenders guard: `jsonwebtoken.verify` only enforces `exp`
    // when the claim is present. A forged-but-signature-valid token without
    // `exp` would otherwise pass verify and be replayable forever. Confirm
    // the explicit `payload.exp === undefined` check rejects it.
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });

    const forged = jwt.sign(
      {
        sub: sessionId,
        uid: 'u1',
        aud: MCP_TOKEN_AUDIENCE,
        iss: MCP_TOKEN_ISSUER,
        jti: generateId(),
        // no `exp` — deliberate
      },
      JWT_SECRET,
      { algorithm: 'HS256', noTimestamp: true }
    );

    expect(await validateSessionToken(makeApp(), forged)).toBeNull();
  });

  dbTest('rejects a signature-valid token that has an exp but is missing jti', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });

    const nowSec = Math.floor(Date.now() / 1000);
    const forged = jwt.sign(
      {
        sub: sessionId,
        uid: 'u1',
        aud: MCP_TOKEN_AUDIENCE,
        iss: MCP_TOKEN_ISSUER,
        iat: nowSec,
        exp: nowSec + 60,
        // no `jti` — deliberate
      },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );

    expect(await validateSessionToken(makeApp(), forged)).toBeNull();
  });
});
