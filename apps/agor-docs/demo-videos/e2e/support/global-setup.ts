import { setupHarness } from './harness.ts';

export default async function globalSetup(): Promise<void> {
  await setupHarness();
}
