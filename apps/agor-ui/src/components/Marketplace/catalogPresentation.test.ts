import type { MCPCatalogEntry } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  CONNECTABLE_AUTH_TYPES,
  capabilityLabel,
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
    verified: false,
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

  it('refuses a locally-run server', () => {
    expect(
      connectBlockedReason(entry({ transport: 'stdio', has_remote: false, remote_url: undefined }))
    ).toMatch(/runs locally/i);
  });

  it.each(['oauth', 'credentials'] as const)(
    'refuses %s auth while only the no-auth branch exists',
    (authType) => {
      expect(connectBlockedReason(entry({ auth_type: authType }))).toMatch(/needs an account/i);
    }
  );
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
      label: 'Runs locally',
    });
    expect(connectStatus(entry({ auth_type: 'oauth' }))).toMatchObject({
      readiness: 'blocked',
      label: 'Needs an account',
    });
  });
});

describe('isConnectable', () => {
  it('agrees with the card: an entry with no stated auth is connectable', () => {
    expect(isConnectable(entry({ auth_type: 'unknown' }))).toBe(true);
    expect(connectStatus(entry({ auth_type: 'unknown' })).readiness).not.toBe('blocked');
  });

  it('excludes what the card calls blocked', () => {
    expect(isConnectable(entry({ auth_type: 'oauth' }))).toBe(false);
    expect(isConnectable(entry({ auth_type: 'credentials' }))).toBe(false);
    expect(
      isConnectable(entry({ transport: 'stdio', has_remote: false, remote_url: undefined }))
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
