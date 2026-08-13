import type { MCPCatalogEntry, MCPCatalogEntryID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  CONNECTABLE_PROBE_VERDICTS,
  capabilityLabel,
  connectBlockedReason,
  connectStatus,
  DEFAULT_SORT,
  entryTitle,
  isConnectable,
} from './catalogPresentation';

function entry(overrides: Partial<MCPCatalogEntry> = {}): MCPCatalogEntry {
  return {
    catalog_entry_id: 'id' as MCPCatalogEntryID,
    created_at: new Date(0),
    updated_at: new Date(0),
    name: 'com.example/mcp',
    has_remote: true,
    has_package: false,
    curated: true,
    verified: false,
    remote_url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    probed_auth_type: 'none',
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
  it('allows a curated, remote, no-auth entry', () => {
    expect(connectBlockedReason(entry())).toBeUndefined();
  });

  it('treats an unprobed entry as connectable — connect probes on demand', () => {
    expect(connectBlockedReason(entry({ probed_auth_type: 'unknown' }))).toBeUndefined();
  });

  it('refuses an entry that has not been reviewed', () => {
    expect(connectBlockedReason(entry({ curated: false }))).toMatch(/reviewed by Preset/i);
  });

  it('refuses a locally-run server', () => {
    expect(
      connectBlockedReason(entry({ transport: 'stdio', has_remote: false, remote_url: undefined }))
    ).toMatch(/runs locally/i);
  });

  it.each(['oauth', 'credentials'] as const)(
    'refuses %s auth while only the no-auth branch exists',
    (authType) => {
      expect(connectBlockedReason(entry({ probed_auth_type: authType }))).toMatch(
        /needs an account/i
      );
    }
  );

  it('refuses an entry that discloses nothing, so no button can promise a connect', () => {
    expect(connectBlockedReason(entry({ permission_disclosure: undefined }))).toMatch(
      /has not stated what it can access/i
    );
  });

  it('refuses an unreachable endpoint', () => {
    expect(connectBlockedReason(entry({ probed_auth_type: 'unreachable' }))).toMatch(
      /could not be reached/i
    );
  });
});

describe('connectStatus', () => {
  it('says an unprobed entry may still ask for an account, rather than promising either way', () => {
    const status = connectStatus(entry({ probed_auth_type: 'unknown' }));
    expect(status.readiness).toBe('unchecked');
    expect(status.detail).toMatch(/may ask for an account/i);
    // Still connectable — the endpoint probes on demand, and this is the only
    // way to find out on an install that has never run a registry sync.
    expect(connectBlockedReason(entry({ probed_auth_type: 'unknown' }))).toBeUndefined();
  });

  it('says outright when no account is needed', () => {
    expect(connectStatus(entry()).readiness).toBe('ready');
  });

  it('carries a card-sized label for every blocked reason', () => {
    expect(connectStatus(entry({ curated: false }))).toMatchObject({
      readiness: 'blocked',
      label: 'Not reviewed',
    });
    expect(connectStatus(entry({ probed_auth_type: 'oauth' }))).toMatchObject({
      readiness: 'blocked',
      label: 'Needs an account',
    });
  });
});

describe('isConnectable', () => {
  it('agrees with the card: an unprobed entry is connectable', () => {
    expect(isConnectable(entry({ probed_auth_type: 'unknown' }))).toBe(true);
    expect(connectStatus(entry({ probed_auth_type: 'unknown' })).readiness).not.toBe('blocked');
  });

  it('excludes what the card calls blocked', () => {
    expect(isConnectable(entry({ probed_auth_type: 'oauth' }))).toBe(false);
    expect(isConnectable(entry({ probed_auth_type: 'unreachable' }))).toBe(false);
    expect(isConnectable(entry({ curated: false }))).toBe(false);
  });

  it('is the rule the query filter sends, so the two cannot drift', () => {
    // Every verdict the filter keeps must be one the presentation also keeps.
    for (const verdict of CONNECTABLE_PROBE_VERDICTS) {
      expect(isConnectable(entry({ probed_auth_type: verdict }))).toBe(true);
    }
  });
});

describe('sort default', () => {
  it("is curated rank, not the spec's install count — nothing counts installs", () => {
    expect(DEFAULT_SORT).toBe('popularity');
  });
});
