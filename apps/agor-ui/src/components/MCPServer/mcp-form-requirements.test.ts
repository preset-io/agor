import { describe, expect, it } from 'vitest';
import {
  describeMissingForOAuth,
  describeMissingForSave,
  firstFormErrorMessage,
  missingMCPFieldLabels,
  requiredMCPFields,
} from './mcp-form-requirements';

describe('requiredMCPFields', () => {
  it('requires the internal ID only where it can still be set', () => {
    expect(requiredMCPFields({ mode: 'create', transport: 'http' })).toContain('name');
    // The edit form renders it disabled, so an existing row always has one.
    expect(requiredMCPFields({ mode: 'edit', transport: 'http' })).not.toContain('name');
  });

  it('asks a stdio server for a command and a remote one for a URL', () => {
    expect(requiredMCPFields({ mode: 'create', transport: 'stdio' })).toEqual(['name', 'command']);
    expect(requiredMCPFields({ mode: 'create', transport: 'http' })).toEqual(['name', 'url']);
    expect(requiredMCPFields({ mode: 'edit', transport: 'sse' })).toEqual(['url']);
  });

  it('leaves auth out of a stdio server, which has none to configure', () => {
    expect(requiredMCPFields({ mode: 'create', transport: 'stdio', authType: 'jwt' })).toEqual([
      'name',
      'command',
    ]);
  });

  it('requires credentials on CREATE but leaves an explicitly cleared saved row editable', () => {
    expect(requiredMCPFields({ mode: 'edit', transport: 'http', authType: 'bearer' })).toEqual([
      'url',
    ]);
    expect(requiredMCPFields({ mode: 'edit', transport: 'http', authType: 'jwt' })).toEqual([
      'url',
      'jwt_api_url',
    ]);
    expect(requiredMCPFields({ mode: 'create', transport: 'http', authType: 'bearer' })).toEqual([
      'name',
      'url',
      'auth_token',
    ]);
    expect(requiredMCPFields({ mode: 'create', transport: 'http', authType: 'jwt' })).toEqual([
      'name',
      'url',
      'jwt_api_url',
      'jwt_api_token',
      'jwt_api_secret',
    ]);
    // OAuth discovers its own endpoints, so the URL is all it needs up front.
    expect(requiredMCPFields({ mode: 'edit', transport: 'http', authType: 'oauth' })).toEqual([
      'url',
    ]);
  });
});

describe('missingMCPFieldLabels', () => {
  const context = { mode: 'create', transport: 'http' } as const;

  it('names the blank fields by the label rendered above them', () => {
    expect(missingMCPFieldLabels({}, context)).toEqual(['Name (Internal ID)', 'URL']);
    expect(missingMCPFieldLabels({ name: 'context7' }, context)).toEqual(['URL']);
  });

  it('counts whitespace as blank', () => {
    expect(missingMCPFieldLabels({ name: '   ', url: 'https://mcp.example' }, context)).toEqual([
      'Name (Internal ID)',
    ]);
  });

  it('is satisfied by a filled form, leaving the value rules to the field', () => {
    expect(
      missingMCPFieldLabels({ name: 'Not A Slug', url: 'https://mcp.example' }, context)
    ).toEqual([]);
  });

  it('ignores fields the current transport and auth type do not render', () => {
    expect(
      missingMCPFieldLabels(
        { name: 'local', command: 'npx' },
        { mode: 'create', transport: 'stdio' }
      )
    ).toEqual([]);
  });
});

describe('the wording of a blocked action', () => {
  it('reads as a sentence for one, two, and more fields', () => {
    expect(describeMissingForSave(['URL'])).toBe('Fill in URL to save this server.');
    expect(describeMissingForSave(['Name (Internal ID)', 'URL'])).toBe(
      'Fill in Name (Internal ID) and URL to save this server.'
    );
    expect(describeMissingForSave(['API URL', 'API Token', 'API Secret'])).toBe(
      'Fill in API URL, API Token, and API Secret to save this server.'
    );
  });

  it('says why OAuth needs fields it never sends', () => {
    expect(describeMissingForOAuth(['Name (Internal ID)'])).toBe(
      'Starting OAuth saves this server first — fill in Name (Internal ID).'
    );
  });
});

describe('firstFormErrorMessage', () => {
  it('pulls the first field complaint out of an AntD rejection', () => {
    expect(
      firstFormErrorMessage({
        errorFields: [
          { name: ['name'], errors: [] },
          { name: ['url'], errors: ['Please enter a URL'] },
        ],
      })
    ).toBe('Please enter a URL');
  });

  it('returns null for anything that is not a validation rejection', () => {
    expect(firstFormErrorMessage(new Error('Network down'))).toBeNull();
    expect(firstFormErrorMessage(undefined)).toBeNull();
    expect(firstFormErrorMessage({ errorFields: [] })).toBeNull();
  });
});
