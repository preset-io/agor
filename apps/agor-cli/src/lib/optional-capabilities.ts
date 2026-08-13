export const WEB_TERMINAL_RUNTIME_DOCS =
  'https://agor.live/guide/extended-install#optional-web-terminal-runtime';

export type OptionalCapabilityDiagnosis = {
  status: 'ready' | 'unavailable';
  optional: true;
  detail?: string;
  docs: string;
};

type PtyRuntime = {
  spawn?: (
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
  ) => {
    onData: (listener: (chunk: string) => void) => unknown;
    onExit: (listener: (event: { exitCode: number }) => void) => unknown;
    kill: () => void;
  };
};

async function probePtyRuntime(runtime: PtyRuntime): Promise<void> {
  if (typeof runtime.spawn !== 'function') throw new Error('PTY module has no spawn function');
  const marker = 'agor-pty-ready';
  const child = runtime.spawn(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(marker)})`],
    { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env }
  );
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('PTY runtime probe timed out'));
    }, 3_000);
    child.onData((chunk) => {
      output += chunk;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0 && output.includes(marker)) resolve();
      else reject(new Error(`PTY runtime probe failed with exit code ${exitCode}`));
    });
  });
}

export async function diagnoseWebTerminalRuntime(
  load: () => Promise<PtyRuntime> = () => import('@lydell/node-pty'),
  probe: (runtime: PtyRuntime) => Promise<void> = probePtyRuntime
): Promise<OptionalCapabilityDiagnosis> {
  try {
    const runtime = await load();
    await probe(runtime);
    return { status: 'ready', optional: true, docs: WEB_TERMINAL_RUNTIME_DOCS };
  } catch (error) {
    return {
      status: 'unavailable',
      optional: true,
      detail: error instanceof Error ? error.message : String(error),
      docs: WEB_TERMINAL_RUNTIME_DOCS,
    };
  }
}
