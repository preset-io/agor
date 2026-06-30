export interface LocalActionResult {
  logs: string[];
}

export interface LocalActionReporter {
  log(message: string): void;
}

export function createBufferedReporter(): LocalActionReporter & LocalActionResult {
  const logs: string[] = [];
  return {
    logs,
    log(message: string) {
      logs.push(message);
    },
  };
}

export interface LocalActionOptions {
  dryRun?: boolean;
  verbose?: boolean;
  reporter?: LocalActionReporter;
}

export function getReporter(options?: LocalActionOptions): LocalActionReporter {
  return options?.reporter ?? { log: () => undefined };
}
