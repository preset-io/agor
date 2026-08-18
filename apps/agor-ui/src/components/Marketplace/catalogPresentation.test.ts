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

  it('allows oauth: connecting sets it up and the user signs in afterwards', () => {
    expect(connectBlockedReason(entry({ auth_type: 'oauth' }))).toBeUndefined();
  });

  it('refuses credentials auth, which nothing can obtain for the user', () => {
    expect(connectBlockedReason(entry({ auth_type: 'credentials' }))).toMatch(/needs an API key/i);
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
    expect(connectStatus(entry({ auth_type: 'credentials' }))).toMatchObject({
      readiness: 'blocked',
      label: 'Needs an API key',
    });
  });

  it('separates "sign in afterwards" from "no account needed"', () => {
    // Both connect, so both must not be `blocked` — but a card promising "no
    // account needed" over a server that wants the user's Notion login is the
    // thing this vocabulary exists to prevent.
    const oauth = connectStatus(entry({ auth_type: 'oauth' }));
    expect(oauth.readiness).toBe('sign-in');
    expect(oauth.readiness).not.toBe(connectStatus(entry()).readiness);
    expect(oauth.detail).toMatch(/your own account/i);
  });
});

describe('isConnectable', () => {
  it('agrees with the card: an entry with no stated auth is connectable', () => {
    expect(isConnectable(entry({ auth_type: 'unknown' }))).toBe(true);
    expect(connectStatus(entry({ auth_type: 'unknown' })).readiness).not.toBe('blocked');
  });

  it('excludes what the card calls blocked', () => {
    expect(isConnectable(entry({ auth_type: 'credentials' }))).toBe(false);
    expect(
      isConnectable(entry({ transport: 'stdio', has_remote: false, remote_url: undefined }))
    ).toBe(false);
  });

  it('keeps oauth, which connects and then asks the user to sign in', () => {
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
