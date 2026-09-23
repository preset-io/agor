import { createGit } from '../git/index.js';

/** Read-only preview commands have both a wall-clock and retained-output budget. */
export async function readBoundedGit(
  root: string,
  args: string[],
  maxBytes: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const { git } = createGit(root, undefined, controller.signal);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let exceeded = false;
  git.outputHandler((_command, stdout, stderr) => {
    // Replace simple-git's unbounded collectors, as cleanIgnoredWorkspace does.
    stdout.removeAllListeners('data');
    const errorCollectors = stderr.listeners('data');
    stderr.removeAllListeners('data');
    let errorBytes = 0;
    stderr.on('data', (chunk: Buffer) => {
      // simple-git needs stderr to recognize nonzero exits. Retain only a small
      // prefix, never forward repository diagnostics to the preview caller.
      const prefix = chunk.subarray(0, Math.max(0, 4096 - errorBytes));
      errorBytes += prefix.length;
      if (prefix.length > 0) {
        for (const collect of errorCollectors) collect.call(stderr, prefix);
      }
    });
    stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        exceeded = true;
        controller.abort();
      } else {
        chunks.push(chunk);
      }
    });
  });
  try {
    await git.raw(args);
    if (exceeded) throw new Error('Git preview output limit exceeded');
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    throw new Error('Git preview unavailable or exceeded its read budget');
  } finally {
    clearTimeout(timer);
  }
}
