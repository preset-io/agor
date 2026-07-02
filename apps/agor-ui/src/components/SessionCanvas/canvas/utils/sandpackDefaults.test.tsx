import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableSandpackProviderInputs } from './sandpackDefaults';

describe('useStableSandpackProviderInputs', () => {
  it('keeps AppNode Sandpack props stable across equivalent parent rerenders', () => {
    const initialProps = {
      files: { '/App.tsx': 'export default function App() { return <div />; }' },
      dependencies: { '@vitejs/plugin-react': '^6.0.0' },
      entryFile: '/App.tsx',
    };
    const { result, rerender } = renderHook(
      ({ files, dependencies, entryFile }) =>
        useStableSandpackProviderInputs({
          template: 'react',
          files,
          dependencies,
          entryFile,
        }),
      { initialProps }
    );
    const first = result.current;

    rerender({
      files: { ...initialProps.files },
      dependencies: { ...initialProps.dependencies },
      entryFile: initialProps.entryFile,
    });

    expect(result.current.files).toBe(first.files);
    expect(result.current.customSetup).toBe(first.customSetup);
    expect(result.current.options).toBe(first.options);
    expect(result.current.files['/styles.css']).toBe('body{margin:0}');
    expect(result.current.customSetup).toEqual({ dependencies: initialProps.dependencies });
    expect(result.current.options).toMatchObject({
      initMode: 'user-visible',
      activeFile: initialProps.entryFile,
    });
  });

  it('keeps ArtifactNode Sandpack props stable across equivalent payload rerenders', () => {
    const initialProps = {
      files: {
        '/src/App.tsx': 'export function App() { return <main>Hello</main>; }',
        '/styles.css': 'body{margin:0}\nmain{padding:8px}',
      },
      customSetup: { devDependencies: { typescript: '^6.0.0' } },
      dependencies: { antd: '^6.4.4' },
      options: { visibleFiles: ['/src/App.tsx'], recompileMode: 'delayed' },
      entryFile: '/src/App.tsx',
    };
    const { result, rerender } = renderHook(
      ({ files, customSetup, dependencies, options, entryFile }) =>
        useStableSandpackProviderInputs({
          template: 'react',
          files,
          customSetup,
          dependencies,
          options,
          entryFile,
        }),
      { initialProps }
    );
    const first = result.current;

    rerender({
      files: { ...initialProps.files },
      customSetup: {
        devDependencies: { ...initialProps.customSetup.devDependencies },
      },
      dependencies: { ...initialProps.dependencies },
      options: {
        visibleFiles: [...initialProps.options.visibleFiles],
        recompileMode: initialProps.options.recompileMode,
      },
      entryFile: initialProps.entryFile,
    });

    expect(result.current.files).toBe(first.files);
    expect(result.current.customSetup).toBe(first.customSetup);
    expect(result.current.options).toBe(first.options);
    expect(result.current.customSetup).toEqual({
      devDependencies: initialProps.customSetup.devDependencies,
      dependencies: initialProps.dependencies,
    });
    expect(result.current.options).toMatchObject({
      initMode: 'user-visible',
      activeFile: initialProps.entryFile,
      visibleFiles: initialProps.options.visibleFiles,
      recompileMode: 'delayed',
    });
  });

  it('ignores standalone dependency churn when customSetup already owns dependencies', () => {
    const customSetup = { dependencies: { react: '^18.3.1' } };
    const { result, rerender } = renderHook(
      ({ dependencies }) =>
        useStableSandpackProviderInputs({
          template: 'react',
          files: { '/App.tsx': 'export default function App() { return <div />; }' },
          customSetup,
          dependencies,
          entryFile: '/App.tsx',
        }),
      { initialProps: { dependencies: { antd: '^6.4.4' } } }
    );
    const first = result.current;

    rerender({ dependencies: { antd: '^6.5.0' } });

    expect(result.current).toBe(first);
    expect(result.current.customSetup).toBe(first.customSetup);
    expect(result.current.customSetup).toEqual(customSetup);
  });

  it('updates Sandpack props when render-affecting content changes', () => {
    const { result, rerender } = renderHook(
      ({ files, options }) =>
        useStableSandpackProviderInputs({
          template: 'react',
          files,
          options,
          entryFile: '/App.tsx',
        }),
      {
        initialProps: {
          files: { '/App.tsx': 'export default function App() { return 1; }' },
          options: { recompileMode: 'delayed' },
        },
      }
    );
    const first = result.current;

    rerender({
      files: { '/App.tsx': 'export default function App() { return 2; }' },
      options: { recompileMode: 'immediate' },
    });

    expect(result.current.files).not.toBe(first.files);
    expect(result.current.options).not.toBe(first.options);
    expect(result.current.files['/App.tsx']).toContain('return 2');
    expect(result.current.options.recompileMode).toBe('immediate');
  });
});
