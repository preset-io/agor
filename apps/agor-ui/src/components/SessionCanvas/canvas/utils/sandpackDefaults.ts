import { useRef } from 'react';

/**
 * Prepend a body margin reset to Sandpack files.
 * The default React template imports /styles.css, so prepending to it
 * is the most reliable way to remove the browser's default body margin.
 * If /styles.css doesn't exist, adds one (the default template auto-imports it).
 */
export function withBodyReset(files: Record<string, string>): Record<string, string> {
  const reset = 'body{margin:0}';
  const key = '/styles.css';
  const existing = files[key];
  if (existing?.includes(reset)) return files;
  return { ...files, [key]: existing ? `${reset}\n${existing}` : reset };
}

type SandpackCustomSetup = Record<string, unknown> & {
  dependencies?: Record<string, string>;
};

type SandpackOptions = Record<string, unknown> & {
  activeFile?: string;
};

export function useStableSandpackProviderInputs({
  template,
  files,
  customSetup,
  dependencies,
  entryFile,
  options,
}: {
  template: string;
  files: Record<string, string>;
  customSetup?: SandpackCustomSetup;
  dependencies?: Record<string, string>;
  entryFile?: string;
  options?: SandpackOptions;
}) {
  const effectiveDependencies = customSetup?.dependencies ? undefined : dependencies;
  const filesKey = useStableValueKey(files);
  const customSetupKey = useStableValueKey(customSetup);
  const dependenciesKey = useStableValueKey(effectiveDependencies);
  const optionsKey = useStableValueKey(options);

  const stableFiles = useStableComputed(filesKey, () => withBodyReset(files));

  const stableCustomSetup = useStableComputed(
    stableValueKey({ customSetupKey, dependenciesKey }),
    () => {
      const merged = {
        ...(customSetup ?? {}),
        ...(effectiveDependencies ? { dependencies: effectiveDependencies } : {}),
      };
      return Object.keys(merged).length > 0 ? merged : undefined;
    }
  );

  const stableOptions = useStableComputed(stableValueKey({ entryFile, optionsKey }), () => ({
    initMode: 'user-visible' as const,
    ...(options ?? {}),
    ...(entryFile && !options?.activeFile ? { activeFile: entryFile } : {}),
  }));

  return useStableComputed(
    stableValueKey({ template, filesKey, customSetupKey, dependenciesKey, entryFile, optionsKey }),
    () => ({
      template,
      files: stableFiles,
      customSetup: stableCustomSetup,
      options: stableOptions,
    })
  );
}

function useStableValueKey(value: unknown): string {
  const ref = useRef<{ value: unknown; key: string } | null>(null);
  if (!ref.current || !Object.is(ref.current.value, value)) {
    ref.current = { value, key: stableValueKey(value) };
  }
  return ref.current.key;
}

function useStableComputed<T>(key: string, compute: () => T): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  if (!ref.current || ref.current.key !== key) {
    ref.current = { key, value: compute() };
  }
  return ref.current.value;
}

function stableValueKey(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toStableJsonValue);
  if (!value || typeof value !== 'object') return value;

  const stableObject: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) stableObject[key] = toStableJsonValue(entry);
  }
  return stableObject;
}
