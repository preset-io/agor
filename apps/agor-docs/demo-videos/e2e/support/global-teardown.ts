import { teardownHarness } from './harness.ts';

export default async function globalTeardown(): Promise<void> {
  await teardownHarness();
}
