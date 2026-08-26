import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  CONNECTABLE_AUTH_TYPES,
  capabilityLabel,
  catalogAuthenticationDetail,
  connectBlockedReason,
  connectStatus,
  DEFAULT_SORT,
  entryTitle,
  isConnectable,
} from './catalogPresentation';

function entry(overrides: Partial<MCPCatalogEntry> = {}): MCPCatalogEntry {
  return {
    name: 'com.example/mcp',
    category: 'dev-tools',
    capabilities: ['docs'],
    benefit: 'Does a useful thing.',
    starter_prompt: 'Show me what you can do.',
    has_remote: true,
    remote_url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    permission_disclosure: 'Reads public repository content only.',
    ...overrides,
  };
}

describe('entryTitle', () => {
  it('prefers a real title when one exists', () => {
    expect(entryTitle(entry({ title: '  DeepWiki  ' }))).toBe('DeepWiki');
  });

  it('falls back to the publisher label, because curation never fills title', () => {
    expect(entryTitle(entry({ name: 'io.github.github/github-mcp-server' }))).toBe('Github');
    expect(entryTitle(entry({ name: 'co.huggingface/hf-mcp-server' }))).toBe('Huggingface');
  });

  it('skips protocol-name subdomains so a publisher is not labelled "Mcp"', () => {
    expect(entryTitle(entry({ name: 'com.figma.mcp/mcp' }))).toBe('Figma');
  });

  it('keeps the registry name when no label survives', () => {
    expect(entryTitle(entry({ name: 'mcp/mcp' }))).toBe('mcp/mcp');
  });
});

describe('capabilityLabel', () => {
  it('humanizes a machine tag', () => {
    expect(capabilityLabel('pull-requests')).toBe('Pull requests');
    expect(capabilityLabel('ci-cd')).toBe('Ci cd');
  });
});

describe('connectBlockedReason', () => {
  it('allows a remote, no-auth entry', () => {
    expect(connectBlockedReason(entry())).toBeUndefined();
  });

  it('treats an entry with no stated auth as connectable — connect checks it', () => {
    expect(connectBlockedReason(entry({ auth_type: 'unknown' }))).toBeUndefined();
  });

  it('refuses an entry with no endpoint to dial', () => {
    // Unreachable for anything the loader served — it refuses such an entry
    // outright now — but these arrive over the wire, so the UI still answers.
    expect(
      connectBlockedReason(entry({ transport: 'stdio', has_remote: false, remote_url: undefined }))
    ).toMatch(/cannot be installed/i);
  });

  it('allows oauth: connecting opens the provider popup automatically', () => {
    expect(connectBlockedReason(entry({ auth_type: 'oauth' }))).toBeUndefined();
  });

  it('allows credentials auth: the drawer takes a key before connecting', () => {
    // This used to be a refusal. It stopped being one when the drawer gained
    // somewhere to paste a key — `blocked` removes the connect form entirely,
    // which is the opposite of what an entry asking for a key needs.
    expect(connectBlockedReason(entry({ auth_type: 'credentials' }))).toBeUndefined();
  });

  it('refuses nothing on the grounds of auth any more', () => {
    // The claim behind "every catalog entry is installable": no stated auth
    // type is a dead end, and the only remaining refusal is an entry with no
    // endpoint at all.
    for (const auth_type of ['none', 'oauth', 'credentials', 'unknown'] as const) {
      expect(connectBlockedReason(entry({ auth_type }))).toBeUndefined();
    }
  });
});

describe('connectStatus', () => {
  it('says an entry with no stated auth may still ask for one, rather than promising either way', () => {
    const status = connectStatus(entry({ auth_type: 'unknown' }));
    expect(status.readiness).toBe('unchecked');
    expect(status.detail).toMatch(/may ask for an account/i);
    // Still connectable — connecting checks the endpoint, which is the only way
    // to find out about an entry the file says nothing about.
    expect(connectBlockedReason(entry({ auth_type: 'unknown' }))).toBeUndefined();
  });

  it('says outright when no account is needed', () => {
    expect(connectStatus(entry()).readiness).toBe('ready');
  });

  it('carries a card-sized label for every blocked reason', () => {
    expect(
      connectStatus(entry({ transport: 'stdio', has_remote: false, remote_url: undefined }))
    ).toMatchObject({
      readiness: 'blocked',
      label: 'Not installable',
    });
  });

  it('separates "paste a key first" from both blocked and ready', () => {
    // A third thing that is not a refusal: the entry connects, but it asks
    // something of the user before it does rather than after. Sharing
    // `blocked` with "no endpoint at all" is what used to hide the field.
    const keyed = connectStatus(entry({ auth_type: 'credentials' }));
    expect(keyed).toMatchObject({
      readiness: 'api-key',
      label: 'Needs a bearer access token',
    });
    expect(keyed.detail).toMatch(/paste one when you connect/i);
    // Says whose key it is and what becomes of it — the two things a user has
    // to know before typing a credential into somebody else's software.
    expect(keyed.detail).toMatch(/your own account/i);
    expect(keyed.detail).toMatch(/never shows it again|never shown again|for you alone/i);
  });

  it('separates automatic account connection from "no account needed"', () => {
    // Both connect, so both must not be `blocked` — but a card promising "no
    // account needed" over a server that wants the user's Notion login is the
    // thing this vocabulary exists to prevent.
    const oauth = connectStatus(entry({ auth_type: 'oauth' }));
    expect(oauth.readiness).toBe('sign-in');
    expect(oauth.readiness).not.toBe(connectStatus(entry()).readiness);
    expect(oauth.detail).toMatch(/your own account/i);
    expect(oauth.detail).toMatch(/popup/i);
  });
});

describe('catalogAuthenticationDetail', () => {
  it.each([
    ['none', 'required', 'Bearer credential · Live endpoint check'],
    ['credentials', 'not_accepted', 'No credential accepted · Live endpoint check'],
    ['none', 'oauth', 'OAuth · Live endpoint check'],
    ['oauth', 'unsupported', 'Unsupported credential scheme · Live endpoint check'],
  ] as const)(
    'lets live %s/%s evidence override stale catalog metadata',
    (catalogAuthType, liveRequirement, expected) => {
      expect(catalogAuthenticationDetail(catalogAuthType, liveRequirement)).toBe(expected);
    }
  );

  it.each([
    ['none', 'Catalog metadata: no account stated · Live endpoint not checked yet'],
    ['oauth', 'Catalog metadata: OAuth · Live endpoint not checked yet'],
    ['credentials', 'Catalog metadata: bearer credential · Live endpoint not checked yet'],
    ['unknown', 'Unknown · Checked live when you connect'],
  ] as const)('labels unchecked %s catalog metadata as fallback', (catalogAuthType, expected) => {
    expect(catalogAuthenticationDetail(catalogAuthType)).toBe(expected);
  });
});

describe('isConnectable', () => {
  it('agrees with the card: an entry with no stated auth is connectable', () => {
    expect(isConnectable(entry({ auth_type: 'unknown' }))).toBe(true);
    expect(connectStatus(entry({ auth_type: 'unknown' })).readiness).not.toBe('blocked');
  });

  it('excludes what the card calls blocked', () => {
    // Only one thing is blocked now: an entry naming no endpoint.
    expect(
      isConnectable(entry({ transport: 'stdio', has_remote: false, remote_url: undefined }))
    ).toBe(false);
  });

  it('keeps credentials, which connects once a key is pasted', () => {
    expect(isConnectable(entry({ auth_type: 'credentials' }))).toBe(true);
  });

  it('keeps oauth, which connects through the automatic popup', () => {
    expect(isConnectable(entry({ auth_type: 'oauth' }))).toBe(true);
  });

  it('still excludes an endpoint-less oauth entry — nothing to sign into', () => {
    expect(
      isConnectable(
        entry({ auth_type: 'oauth', transport: 'stdio', has_remote: false, remote_url: undefined })
      )
    ).toBe(false);
  });

  it('is the rule the query filter sends, so the two cannot drift', () => {
    // Every auth type the filter keeps must be one the presentation also keeps.
    for (const authType of CONNECTABLE_AUTH_TYPES) {
      expect(isConnectable(entry({ auth_type: authType }))).toBe(true);
    }
  });
});

describe('sort default', () => {
  it("is hand-assigned rank, not the spec's install count — nothing counts installs", () => {
    expect(DEFAULT_SORT).toBe('popularity');
  });
});
