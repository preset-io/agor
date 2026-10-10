import { act, renderHook, waitFor } from '@testing-library/react';
import type { DiagramPlugin, MathPlugin } from 'streamdown';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fresh module state per test: the math plugin is a module-level singleton.
async function loadModule() {
  vi.resetModules();
  return import('./richContentPlugins');
}

function fakeMermaid() {
  const render = vi.fn().mockResolvedValue({ svg: '<svg />' });
  const getMermaid = vi.fn(() => ({ initialize: vi.fn(), render }));
  const plugin: DiagramPlugin = {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid,
  };
  return { plugin, getMermaid, render };
}

const fakeMath: MathPlugin = {
  name: 'katex',
  type: 'math',
  remarkPlugin: () => undefined,
  rehypePlugin: () => undefined,
};

describe('createLazyMermaidPlugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not load Mermaid until a diagram renders, then forwards to it once', async () => {
    const { createLazyMermaidPlugin } = await loadModule();
    const real = fakeMermaid();
    const load = vi.fn().mockResolvedValue(real.plugin);
    const lazy = createLazyMermaidPlugin(load);

    const instance = lazy.getMermaid({ theme: 'dark' });
    expect(load).not.toHaveBeenCalled();

    await expect(instance.render('a', 'graph LR; A-->B')).resolves.toEqual({ svg: '<svg />' });
    await instance.render('b', 'graph LR; B-->C');

    expect(load).toHaveBeenCalledTimes(1);
    expect(real.render).toHaveBeenNthCalledWith(1, 'a', 'graph LR; A-->B');
    expect(real.render).toHaveBeenNthCalledWith(2, 'b', 'graph LR; B-->C');
    // The config is applied on the first render and only again when it changes.
    expect(real.getMermaid).toHaveBeenNthCalledWith(1, { theme: 'dark' });
    expect(real.getMermaid).toHaveBeenNthCalledWith(2, undefined);

    const light = { theme: 'default' as const };
    await lazy.getMermaid(light).render('c', 'graph LR; C-->D');
    expect(real.getMermaid).toHaveBeenNthCalledWith(3, light);
  });

  it('retries the import after a failed load', async () => {
    const { createLazyMermaidPlugin } = await loadModule();
    const real = fakeMermaid();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(real.plugin);
    const instance = createLazyMermaidPlugin(load).getMermaid();

    await expect(instance.render('a', 'x')).rejects.toThrow('chunk failed');
    await expect(instance.render('a', 'x')).resolves.toEqual({ svg: '<svg />' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('math plugin loading', () => {
  it('only treats `$$` as math', async () => {
    const { markdownNeedsMath } = await loadModule();
    expect(markdownNeedsMath('costs $5 and $6')).toBe(false);
    expect(markdownNeedsMath('inline $$x^2$$ math')).toBe(true);
  });

  it('keeps math out of the base plugins and adds it once loaded', async () => {
    const { streamdownRichContentPlugins, withMathPlugin } = await loadModule();
    expect(streamdownRichContentPlugins.math).toBeUndefined();
    expect(withMathPlugin(streamdownRichContentPlugins, null)).toBe(streamdownRichContentPlugins);
    expect(withMathPlugin(streamdownRichContentPlugins, fakeMath).math).toBe(fakeMath);
  });

  it('delivers the loaded plugin only to documents that need math', async () => {
    const module = await loadModule();
    const load = vi.fn().mockResolvedValue(fakeMath);

    const idle = renderHook(() => module.useMathPlugin(false));
    expect(idle.result.current).toBeNull();

    // Load through the injected loader (a document needing math would start
    // the real one). Documents that need math get the plugin; others never do.
    await act(async () => {
      await module.loadMathPlugin(load);
    });
    const needed = renderHook(() => module.useMathPlugin(true));
    await waitFor(() => expect(needed.result.current).toBe(fakeMath));
    expect(idle.result.current).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after a failed load', async () => {
    const { loadMathPlugin } = await loadModule();
    await expect(loadMathPlugin(() => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline'
    );
    await expect(loadMathPlugin(() => Promise.resolve(fakeMath))).resolves.toBeUndefined();
  });
});
