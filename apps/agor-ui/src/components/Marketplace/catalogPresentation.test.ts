import type { MCPCatalogEntry, MCPCatalogEntryID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  capabilityLabel,
  connectBlockedReason,
  DEFAULT_SORT,
  entryTitle,
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

  it('refuses an unreachable endpoint', () => {
    expect(connectBlockedReason(entry({ probed_auth_type: 'unreachable' }))).toMatch(
      /could not be reached/i
    );
  });
});

describe('sort default', () => {
  it("is curated rank, not the spec's install count — nothing counts installs", () => {
    expect(DEFAULT_SORT).toBe('popularity');
  });
});
