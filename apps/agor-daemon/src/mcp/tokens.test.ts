/**
 * MCP token module tests.
 *
 * Exercises the issue → verify → bulk-revoke cycle against an in-memory SQLite
 * database. A minimal repo/worktree/session fixture is seeded so the
 * `mcp_token_generation` lookup in validate/revoke has something to read.
 *
 * Coverage:
 *   - minted tokens carry `jti` + `exp` (+ `iat`, `gen`, `iss`, `aud`) claims
 *   - expired token → rejected
 *   - revokeAllForSession bumps `gen` and invalidates every outstanding token
 *   - legacy tokens (no jti/exp) accepted during grace window, rejected after
 *   - legacy tokens rejected after gen bump / session deletion (even in grace)
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
  getLegacyGraceUntilMs,
  initMcpTokens,
  MCP_TOKEN_AUDIENCE,
  MCP_TOKEN_ISSUER,
  revokeAllForSession,
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
  opts: { sessionId: SessionID; initialGen?: number } = { sessionId: generateId() as SessionID }
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
      mcp_token_generation: opts.initialGen ?? 0,
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
  dbTest('issues a token with jti, exp, iat, aud, iss, gen claims', async ({ db }) => {
    initMcpTokens({ db, expirationMs: 60_000, acceptLegacyGraceMs: 0 });
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
    expect(decoded.gen).toBe(0);
  });

  dbTest('embeds current mcp_token_generation into the gen claim', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, {
      sessionId: generateId() as SessionID,
      initialGen: 7,
    });

    const token = await generateSessionToken(makeApp(), sessionId, 'user-1' as UserID);
    const decoded = jwt.verify(token, JWT_SECRET, {
      audience: MCP_TOKEN_AUDIENCE,
    }) as Record<string, unknown>;

    expect(decoded.gen).toBe(7);
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
// Validation — happy path, expiry, gen mismatch
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
    expect(ctx?.legacy).toBeUndefined();
    expect(typeof ctx?.jti).toBe('string');
    expect(ctx?.gen).toBe(0);
  });

  dbTest('rejects a token whose exp has passed', async ({ db }) => {
    // Fake timers let us fast-forward past the 60s expiry without waiting —
    // `jsonwebtoken.verify` reads `Date.now()` for exp checks, so we must
    // stub the global clock (injecting `now` into the module alone isn't
    // enough because verify uses the system clock directly).
    const baseMs = Date.now();
    vi.useFakeTimers({ now: baseMs, shouldAdvanceTime: false });
    try {
      initMcpTokens({ db, expirationMs: 60_000, acceptLegacyGraceMs: 0 });
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

  dbTest('rejects tokens with a stale gen after revokeAllForSession', async ({ db }) => {
    initMcpTokens({ db });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const t1 = await generateSessionToken(makeApp(), sessionId, 'u1' as UserID);
    const t2 = await generateSessionToken(makeApp(), sessionId, 'u1' as UserID);

    // Sanity: both are valid before the gen bump.
    expect(await validateSessionToken(makeApp(), t1)).not.toBeNull();
    expect(await validateSessionToken(makeApp(), t2)).not.toBeNull();

    const newGen = await revokeAllForSession(db, sessionId, 'manual', 'admin-1');
    expect(newGen).toBe(1);

    // Both outstanding tokens are now stale (gen=0 != current gen=1).
    expect(await validateSessionToken(makeApp(), t1)).toBeNull();
    expect(await validateSessionToken(makeApp(), t2)).toBeNull();

    // A freshly minted token picks up the new gen and is accepted.
    const t3 = await generateSessionToken(makeApp(), sessionId, 'u1' as UserID);
    const ctx = await validateSessionToken(makeApp(), t3);
    expect(ctx?.gen).toBe(1);
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
        gen: 0,
      },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );

    expect(await validateSessionToken(makeApp(), forged)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Legacy-token grace window
// ---------------------------------------------------------------------------

describe('legacy token grace window', () => {
  /**
   * Pre-rollout tokens were minted without `jti` or `exp`. The module accepts
   * them for a grace window after startup so existing sessions don't lose
   * access mid-flight during a rolling deploy.
   */
  function mintLegacyToken(sessionId: SessionID, userId: UserID): string {
    return jwt.sign(
      {
        sub: sessionId,
        uid: userId,
        aud: MCP_TOKEN_AUDIENCE,
      },
      JWT_SECRET,
      { algorithm: 'HS256', noTimestamp: true }
    );
  }

  dbTest('accepts a legacy token during the grace window', async ({ db }) => {
    const nowMs = 1_700_000_000_000;
    initMcpTokens({
      db,
      acceptLegacyGraceMs: 60_000,
      now: () => nowMs,
    });
    expect(getLegacyGraceUntilMs()).toBe(nowMs + 60_000);

    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const legacy = mintLegacyToken(sessionId, 'u1' as UserID);

    const ctx = await validateSessionToken(makeApp(), legacy);
    expect(ctx).not.toBeNull();
    expect(ctx?.legacy).toBe(true);
    expect(ctx?.jti).toBeUndefined();
    expect(ctx?.gen).toBeUndefined();
  });

  dbTest('rejects a legacy token after the grace window closes', async ({ db }) => {
    let nowMs = 1_700_000_000_000;
    initMcpTokens({
      db,
      acceptLegacyGraceMs: 60_000,
      now: () => nowMs,
    });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const legacy = mintLegacyToken(sessionId, 'u1' as UserID);

    nowMs += 120_000; // past the 60s grace
    expect(await validateSessionToken(makeApp(), legacy)).toBeNull();
  });

  dbTest('rejects legacy tokens immediately when acceptLegacyGraceMs is 0', async ({ db }) => {
    initMcpTokens({ db, acceptLegacyGraceMs: 0 });
    expect(getLegacyGraceUntilMs()).toBe(0);

    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const legacy = mintLegacyToken(sessionId, 'u1' as UserID);

    expect(await validateSessionToken(makeApp(), legacy)).toBeNull();
  });

  dbTest(
    'rejects a legacy token after revokeAllForSession bumps gen, even during grace',
    async ({ db }) => {
      // Regression: the legacy-token path used to early-return during grace
      // without checking session existence or gen. That meant a legacy token
      // survived a session-wide revoke. Now it must be rejected.
      initMcpTokens({ db, acceptLegacyGraceMs: 60 * 60 * 1000 });
      const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
      const legacy = mintLegacyToken(sessionId, 'u1' as UserID);

      // Sanity: accepted while gen is still 0.
      expect(await validateSessionToken(makeApp(), legacy)).not.toBeNull();

      await revokeAllForSession(db, sessionId, 'session_archived', 'admin-1');

      // Same legacy token must now be rejected because the session's gen > 0.
      expect(await validateSessionToken(makeApp(), legacy)).toBeNull();
    }
  );

  dbTest('rejects a legacy token for a deleted session, even during grace', async ({ db }) => {
    initMcpTokens({ db, acceptLegacyGraceMs: 60 * 60 * 1000 });
    const sessionId = await seedSession(db, { sessionId: generateId() as SessionID });
    const legacy = mintLegacyToken(sessionId, 'u1' as UserID);

    await deleteFrom(db, sessions).where(eq(sessions.session_id, sessionId)).run();

    expect(await validateSessionToken(makeApp(), legacy)).toBeNull();
  });
});
