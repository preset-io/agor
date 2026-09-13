import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
/** Durable, operator-only whole-worker gate. Restart never silently releases a transfer. */
export class OpsHold {
  id: string | null = null;
  busy = false;
  constructor(private file: string) {}
  async load() {
    try {
      this.id = (await readFile(this.file, 'utf8')).trim();
      if (!this.id) throw new Error('Invalid ops hold');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  async acquire(id: string, idle: boolean) {
    if (this.id) {
      if (this.id !== id) throw new Error('Worker held by another operation');
      return;
    }
    if (!idle) throw new Error('Worker active; wait for tasks and maintenance to finish');
    this.id = id;
    // Persistence failure deliberately retains the in-memory hold.
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, id, { mode: 0o600, flag: 'wx', flush: true });
  }
  require(id: string) {
    if (this.id !== id) throw new Error('Matching durable worker hold required');
  }
  async run<T>(id: string, work: () => Promise<T>) {
    this.require(id);
    if (this.busy) throw new Error('Operation already running');
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  async release(id: string) {
    this.require(id);
    if (this.busy) throw new Error('Operation still running');
    await rm(this.file, { force: true });
    this.id = null;
  }
}
