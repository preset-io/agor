import { startWorker } from './worker.js';

if (!process.argv[2]) throw new Error('Worker configuration path required');
await startWorker(process.argv[2]);
