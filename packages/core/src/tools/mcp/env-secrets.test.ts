import { describe, expect, it } from 'vitest';
import { redactMCPEnvSecrets, restoreRedactedMCPEnvSecrets } from './env-secrets';
import { MCP_HEADER_REDACTED_SENTINEL } from './http-headers';

describe('redactMCPEnvSecrets', () => {
  it('replaces values with the sentinel while keeping the keys', () => {
    expect(redactMCPEnvSecrets({ GITHUB_TOKEN: 'ghp_live', ALLOWED_PATHS: '/srv' })).toEqual({
      GITHUB_TOKEN: MCP_HEADER_REDACTED_SENTINEL,
      ALLOWED_PATHS: MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('keeps a configured-but-hidden variable distinguishable from an unset one', () => {
    // The edit form needs to render "this server sets GITHUB_TOKEN" without
    // rendering the token, so the key survives redaction and an absent env
    // stays absent.
    expect(Object.keys(redactMCPEnvSecrets({ GITHUB_TOKEN: 'ghp_live' }) ?? {})).toEqual([
      'GITHUB_TOKEN',
    ]);
    expect(redactMCPEnvSecrets(undefined)).toBeUndefined();
    expect(redactMCPEnvSecrets({})).toEqual({});
  });

  it('leaves a bare {{ user.env.NAME }} placeholder intact', () => {
    // The placeholder names a variable rather than carrying its value, and
    // the sentinel would turn a resolvable reference into a literal.
    expect(redactMCPEnvSecrets({ TOKEN: '{{ user.env.GITHUB_TOKEN }}' })).toEqual({
      TOKEN: '{{ user.env.GITHUB_TOKEN }}',
    });
  });

  it('redacts partial, helper, and multi-expression templates', () => {
    expect(
      redactMCPEnvSecrets({
        PARTIAL: 'prefix-{{ user.env.A }}',
        HELPER: '{{default user.env.A "sk-live-fallback"}}',
        OTHER: '{{ someOtherThing }}',
      })
    ).toEqual({
      PARTIAL: MCP_HEADER_REDACTED_SENTINEL,
      HELPER: MCP_HEADER_REDACTED_SENTINEL,
      OTHER: MCP_HEADER_REDACTED_SENTINEL,
    });
  });

  it('does not drop env vars that share a name with a reserved HTTP header', () => {
    // Guards against routing `env` through `normalizeMCPCustomHeaders`, which
    // filters these names out — they are ordinary environment variables.
    expect(redactMCPEnvSecrets({ HOST: 'db.internal', TE: '1', UPGRADE: 'yes' })).toEqual({
      HOST: MCP_HEADER_REDACTED_SENTINEL,
      TE: MCP_HEADER_REDACTED_SENTINEL,
      UPGRADE: MCP_HEADER_REDACTED_SENTINEL,
    });
  });
});

describe('restoreRedactedMCPEnvSecrets', () => {
  it('restores the stored value where the form echoed the sentinel back', () => {
    expect(
      restoreRedactedMCPEnvSecrets({
        current: { GITHUB_TOKEN: 'ghp_live', ALLOWED_PATHS: '/srv' },
        next: { GITHUB_TOKEN: MCP_HEADER_REDACTED_SENTINEL, ALLOWED_PATHS: '/srv2' },
      })
    ).toEqual({ GITHUB_TOKEN: 'ghp_live', ALLOWED_PATHS: '/srv2' });
  });

  it('honours a real edit and a deletion', () => {
    expect(
      restoreRedactedMCPEnvSecrets({
        current: { GITHUB_TOKEN: 'ghp_live', STALE: 'x' },
        next: { GITHUB_TOKEN: 'ghp_rotated' },
      })
    ).toEqual({ GITHUB_TOKEN: 'ghp_rotated' });
  });

  it('never persists the sentinel when there is nothing stored to restore', () => {
    expect(
      restoreRedactedMCPEnvSecrets({
        current: undefined,
        next: { NEW: MCP_HEADER_REDACTED_SENTINEL },
      })
    ).toEqual({});
  });

  it('does not resurrect a variable a concurrent edit deleted', () => {
    // Two windows open. One deletes GITHUB_TOKEN. The other, holding a form
    // hydrated before that, saves an unrelated change and echoes the sentinel
    // back. Persisting it would recreate GITHUB_TOKEN as the literal
    // `••••••••`, and every executor would launch with a bogus credential.
    const afterConcurrentDelete = { ALLOWED_PATHS: '/srv' };
    const staleForm = {
      GITHUB_TOKEN: MCP_HEADER_REDACTED_SENTINEL,
      ALLOWED_PATHS: '/srv/changed',
    };

    expect(
      restoreRedactedMCPEnvSecrets({ current: afterConcurrentDelete, next: staleForm })
    ).toEqual({ ALLOWED_PATHS: '/srv/changed' });
  });

  it('cannot set a value that is literally the sentinel, by construction', () => {
    // Documented limitation, not an oversight: the sentinel travels in the
    // same channel as real values, so "unchanged" and "literally this string"
    // are indistinguishable. Keeping the stored value is the safe reading.
    expect(
      restoreRedactedMCPEnvSecrets({
        current: { TOKEN: 'real' },
        next: { TOKEN: MCP_HEADER_REDACTED_SENTINEL },
      })
    ).toEqual({ TOKEN: 'real' });
  });

  it('returns undefined when no env was submitted', () => {
    expect(restoreRedactedMCPEnvSecrets({ current: { A: 'b' }, next: undefined })).toBeUndefined();
  });
});
