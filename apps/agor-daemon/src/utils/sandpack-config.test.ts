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
  effectiveTemplateForArtifact,
  envVarPrefixForTemplate,
  normalizeSandpackConfigForRender,
  renderTemplateForArtifact,
  sanitizeSandpackConfig,
  shouldUseStaticTemplate,
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
  it('CRA-based React templates get REACT_APP_', () => {
    // sandpack-react v2 ships `react` and `react-ts` with
    // `environment: 'create-react-app'`. Vite-style `import.meta.env` is
    // unavailable there — env vars reach `process.env.REACT_APP_X`.
    expect(envVarPrefixForTemplate('react')).toBe('REACT_APP_');
    expect(envVarPrefixForTemplate('react-ts')).toBe('REACT_APP_');
  });

  it('Vite-family templates get VITE_', () => {
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

describe('effectiveTemplateForArtifact', () => {
  it('returns artifact.template when sandpack_config has no override', () => {
    expect(effectiveTemplateForArtifact({ template: 'react' })).toBe('react');
    expect(effectiveTemplateForArtifact({ template: 'svelte', sandpack_config: {} })).toBe(
      'svelte'
    );
  });

  it('prefers sandpack_config.template when set (UI uses this for rendering)', () => {
    // If an author flips the runtime via sandpack_config.template, env
    // synthesis must follow — otherwise the daemon would prefix for one
    // bundler while the UI renders with a different one.
    expect(
      effectiveTemplateForArtifact({
        template: 'react',
        sandpack_config: { template: 'svelte' },
      })
    ).toBe('svelte');
  });

  it('falls back to artifact.template when sandpack_config.template is an unknown string', () => {
    // DB rows / round-tripped sidecars / REST payloads can carry arbitrary
    // strings cast through `SandpackTemplate` at the type boundary. Without
    // this guard the prefix lookup returns `undefined` and the synth emits
    // literal `undefinedOPENAI_KEY=…` lines into the served `.env`.
    expect(
      effectiveTemplateForArtifact({
        template: 'react',
        sandpack_config: { template: 'totally-not-a-template' as any },
      })
    ).toBe('react');
  });
});

describe('envVarPrefixForTemplate runtime guard', () => {
  it('returns null for any value not in the known-template table', () => {
    // Even though the TypeScript signature says `SandpackTemplate`,
    // runtime callers can hand us anything. The helper must not return
    // `undefined` — synth would then write the literal string
    // "undefined" into `.env` lines.
    expect(envVarPrefixForTemplate('bogus' as any)).toBeNull();
    expect(envVarPrefixForTemplate('' as any)).toBeNull();
  });
});

describe('sanitizeSandpackConfig.template', () => {
  it('keeps known SandpackTemplate values', () => {
    expect(sanitizeSandpackConfig({ template: 'react' }).template).toBe('react');
    expect(sanitizeSandpackConfig({ template: 'svelte' }).template).toBe('svelte');
  });

  it('drops unknown template strings instead of casting them through', () => {
    expect(
      sanitizeSandpackConfig({ template: 'react-vite-experimental' }).template
    ).toBeUndefined();
    expect(sanitizeSandpackConfig({ template: 42 as unknown as string }).template).toBeUndefined();
  });
});

describe('HTML-first vanilla artifact rendering', () => {
  const affectedShape = {
    template: 'vanilla' as const,
    files: {
      '/index.js': '// generated entry intentionally left empty\n',
      '/index.html': `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/external.css">
    <style>body { font-family: Inter, sans-serif; }</style>
  </head>
  <body><main class="hero">Styled artifact</main><script src="/external.js"></script></body>
</html>`,
      '/external.css': '.hero { color: rebeccapurple; }',
      '/external.js': 'document.body.dataset.loaded = "yes";',
    },
  };

  it('recognizes the HTML-first shape instead of accepting an inert JS entry', () => {
    expect(shouldUseStaticTemplate(affectedShape)).toBe(true);
    expect(renderTemplateForArtifact(affectedShape)).toBe('static');
  });

  it('selects Sandpack static entry semantics without rewriting HTML/CSS/scripts', () => {
    const normalized = normalizeSandpackConfigForRender(affectedShape);

    expect(normalized.template).toBe('static');
    expect(normalized.sandpack_config).toMatchObject({
      template: 'static',
      customSetup: { entry: '/index.html' },
    });
    expect(affectedShape.files['/index.html']).toContain('font-family: Inter');
    expect(affectedShape.files['/index.html']).toContain('/external.css');
    expect(affectedShape.files['/index.html']).toContain('/external.js');
    expect(affectedShape.files['/index.js']).toContain('intentionally left empty');
  });

  it('does not carry a stale vanilla environment into the static runtime', () => {
    const artifact = {
      ...affectedShape,
      sandpack_config: {
        customSetup: {
          entry: '/index.js',
          environment: 'parcel',
          dependencies: { 'safe-dependency': '^1.0.0' },
        },
      },
    };
    const normalized = normalizeSandpackConfigForRender(artifact);

    expect(normalized.sandpack_config?.customSetup).toEqual({
      entry: '/index.html',
      dependencies: { 'safe-dependency': '^1.0.0' },
    });
    expect(artifact.sandpack_config.customSetup.environment).toBe('parcel');
  });

  it('does not guess static for missing, malformed, or alternate entry paths', () => {
    const html = '<main>HTML content</main>';

    expect(
      renderTemplateForArtifact({
        template: 'vanilla',
        files: { '/index.html': html },
      })
    ).toBe('vanilla');
    expect(
      renderTemplateForArtifact({
        template: 'vanilla',
        files: { '/index.js': '/* unterminated', '/index.html': html },
      })
    ).toBe('vanilla');
    expect(
      renderTemplateForArtifact({
        template: 'vanilla',
        entry: '/alternate.js',
        files: {
          '/index.js': '// conventional entry is also empty',
          '/index.html': html,
        },
      })
    ).toBe('vanilla');
    expect(
      renderTemplateForArtifact({
        template: 'vanilla',
        sandpack_config: { customSetup: { entry: '/alternate.js' } },
        files: {
          '/alternate.js': '// empty',
          '/index.js': '// conventional entry is also empty',
          '/index.html': html,
        },
      })
    ).toBe('vanilla');
    expect(
      renderTemplateForArtifact({
        template: 'vanilla',
        sandpack_config: { customSetup: { entry: '/alternate.html' } },
        files: {
          '/alternate.html': html,
          '/index.js': '// conventional entry is also empty',
          '/index.html': html,
        },
      })
    ).toBe('vanilla');
  });

  it('gives an explicit static template its deterministic HTML entry', () => {
    const normalized = normalizeSandpackConfigForRender({
      template: 'static',
      files: { '/index.html': '<main>static</main>' },
    });

    expect(normalized).toEqual({
      template: 'static',
      sandpack_config: {
        template: 'static',
        customSetup: { entry: '/index.html' },
      },
    });
  });

  it('is idempotent when normalizing a repaired artifact repeatedly', () => {
    const first = normalizeSandpackConfigForRender(affectedShape);
    const second = normalizeSandpackConfigForRender({
      ...affectedShape,
      template: first.template,
      sandpack_config: first.sandpack_config,
    });

    expect(second).toEqual(first);
  });

  it('keeps executable vanilla JavaScript on the vanilla template', () => {
    expect(
      renderTemplateForArtifact({
        ...affectedShape,
        files: { ...affectedShape.files, '/index.js': 'document.body.dataset.ready = "yes";' },
      })
    ).toBe('vanilla');
  });

  it('does not reclassify framework artifacts that happen to contain index.html', () => {
    expect(
      renderTemplateForArtifact({
        template: 'react',
        files: affectedShape.files,
      })
    ).toBe('react');
    expect(
      renderTemplateForArtifact({
        template: 'vue3',
        files: affectedShape.files,
      })
    ).toBe('vue3');
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
          'export const u = "{{ agor.apiUrl }}";',
          'export const e = "{{ agor.userEmail }}";',
        ].join('\n'),
      },
    });
    expect(result.detected_grants).toContain('agor_api_url');
    expect(result.detected_grants).toContain('agor_user_email');
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
