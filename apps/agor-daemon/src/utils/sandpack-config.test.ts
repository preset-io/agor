/**
 * Tests for the sandpack-config helpers.
 *
 * Coverage:
 * - sanitizeSandpackConfig blocks the unsafe prop list
 * - envVarPrefixForTemplate returns the right prefix per template family
 * - detectLegacyFormat catches sandpack.json + Handlebars and emits a useful
 *   upgrade prompt with the parsed env vars and grant keys interpolated
 */

import { describe, expect, it } from 'vitest';
import {
  detectLegacyFormat,
  envVarPrefixForTemplate,
  sanitizeSandpackConfig,
} from './sandpack-config';

describe('sanitizeSandpackConfig', () => {
  it('strips block-listed top-level props', () => {
    const out = sanitizeSandpackConfig({
      template: 'react',
      teamId: 'cs-team-1',
      sandboxId: 'cs-box-1',
    });
    expect(out.template).toBe('react');
    expect((out as Record<string, unknown>).teamId).toBeUndefined();
    expect((out as Record<string, unknown>).sandboxId).toBeUndefined();
  });

  it('strips bundlerURL / externalResources / npmRegistries / exportOptions', () => {
    const out = sanitizeSandpackConfig({
      options: {
        bundlerURL: 'https://attacker.example/sandpack/',
        externalResources: ['https://attacker.example/xss.js'],
        showLineNumbers: true,
      },
      customSetup: {
        dependencies: { react: '18.0.0' },
        npmRegistries: [{ enabledScopes: [] }],
        exportOptions: { secret: 'x' },
        entry: '/index.js',
      },
    });
    expect(out.options?.bundlerURL).toBeUndefined();
    expect((out.options as Record<string, unknown>).externalResources).toBeUndefined();
    expect(out.options?.showLineNumbers).toBe(true);
    expect((out.customSetup as Record<string, unknown>).npmRegistries).toBeUndefined();
    expect((out.customSetup as Record<string, unknown>).exportOptions).toBeUndefined();
    expect(out.customSetup?.entry).toBe('/index.js');
    expect(out.customSetup?.dependencies?.react).toBe('18.0.0');
  });

  it("drops options.classes values that don't match the safe regex", () => {
    const out = sanitizeSandpackConfig({
      options: {
        classes: {
          ok: 'safe-class',
          bad: 'agor-internal-css "><script>',
        },
      },
    });
    expect(out.options?.classes?.ok).toBe('safe-class');
    expect(out.options?.classes?.bad).toBeUndefined();
  });

  it('returns {} for non-object input', () => {
    expect(sanitizeSandpackConfig(null)).toEqual({});
    expect(sanitizeSandpackConfig('not a config')).toEqual({});
    expect(sanitizeSandpackConfig(['array'])).toEqual({});
  });
});

describe('envVarPrefixForTemplate', () => {
  it('vite-family templates get VITE_', () => {
    expect(envVarPrefixForTemplate('react')).toBe('VITE_');
    expect(envVarPrefixForTemplate('react-ts')).toBe('VITE_');
    expect(envVarPrefixForTemplate('vue3')).toBe('VITE_');
    expect(envVarPrefixForTemplate('svelte')).toBe('VITE_');
    expect(envVarPrefixForTemplate('solid')).toBe('VITE_');
  });

  it('vanilla / static templates get null (no env path)', () => {
    expect(envVarPrefixForTemplate('vanilla')).toBeNull();
    expect(envVarPrefixForTemplate('vanilla-ts')).toBeNull();
  });

  it('other templates default to no prefix (process.env.X)', () => {
    expect(envVarPrefixForTemplate('vue')).toBe('');
    expect(envVarPrefixForTemplate('angular')).toBe('');
  });
});

describe('detectLegacyFormat', () => {
  it('flags sandpack.json + agor.config.js in the file map', () => {
    const result = detectLegacyFormat({
      files: {
        '/sandpack.json': '{"template": "react"}',
        '/agor.config.js': 'export const x = "{{ user.env.OPENAI_KEY }}"',
        '/App.js': 'export default function App() { return null; }',
      },
    });
    expect(result.is_legacy).toBe(true);
    expect(result.signals).toContain('has_sandpack_json');
    expect(result.signals).toContain('has_agor_config_js');
    expect(result.signals).toContain('has_handlebars_user_env');
    expect(result.detected_env_vars).toContain('OPENAI_KEY');
    expect(result.upgrade_instructions).toContain('OPENAI_KEY');
    expect(result.upgrade_instructions).toContain('sandpack.json');
    expect(result.upgrade_instructions).toContain('agor.config.js');
  });

  it('extracts grant keys from {{ agor.* }} references', () => {
    const result = detectLegacyFormat({
      files: {
        '/agor.config.js': [
          'export const t = "{{ agor.token }}";',
          'export const u = "{{ agor.apiUrl }}";',
          'export const p = "{{ agor.proxies.openai.url }}";',
        ].join('\n'),
      },
    });
    expect(result.detected_grants).toContain('agor_token');
    expect(result.detected_grants).toContain('agor_api_url');
    expect(result.detected_grants.some((g) => g.startsWith('agor_proxies:openai'))).toBe(true);
    expect(result.upgrade_instructions).toMatch(/agor_proxies/);
  });

  it('returns is_legacy=false for a clean new-format artifact', () => {
    const result = detectLegacyFormat({
      files: { '/index.js': 'console.log("hi")', '/package.json': '{}' },
      sandpack_config: { template: 'react' },
      required_env_vars: ['OPENAI_KEY'],
    });
    expect(result.is_legacy).toBe(false);
    expect(result.signals).toEqual([]);
  });
});
