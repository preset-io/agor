/** Human progress stays off stdout, including when stdout is redirected for JSON. */
export class KnowledgeProgress {
  private last = 0;
  private started = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private message = '';
  constructor(private output: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stderr) {}
  report(phase: string, completed: number, total?: number, detail = '') {
    this.message =
      `${phase}: ${completed}${total === undefined ? ' discovered' : ` / ${total}`} ${detail}`.trim();
    this.render(completed === 0 || completed === total);
  }
  private render(force: boolean) {
    const now = Date.now();
    if (!force && now - this.last < 500) return;
    this.last = now;
    const line = `${this.message} | elapsed ${Math.floor((now - this.started) / 1000)}s`;
    this.output.write(this.output.isTTY ? `\r\x1b[2K${line}` : `${line}\n`);
  }
  async waiting<T>(operation: () => Promise<T>): Promise<T> {
    this.timer = setInterval(() => this.render(true), 5000);
    try {
      return await operation();
    } finally {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  summary(text: string) {
    if (this.output.isTTY) this.output.write('\n');
    this.output.write(`${text}\n`);
  }
  failure(note: string) {
    this.summary(`Stopped: ${this.message || 'before planning'}\n${note}`);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    if (this.output.isTTY) this.output.write('\n');
  }
}
