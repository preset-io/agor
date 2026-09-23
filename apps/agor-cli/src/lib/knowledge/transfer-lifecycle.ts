import { KnowledgeProgress } from './progress';

/** Scope process listeners and progress to one transfer; always release its client. */
export async function withKnowledgeTransfer<T>(
  options: { failureNote: string; cleanup: () => Promise<void> },
  operation: (context: { signal: AbortSignal; progress: KnowledgeProgress }) => Promise<T>
): Promise<T> {
  const progress = new KnowledgeProgress();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    return await operation({ signal: controller.signal, progress });
  } catch (error) {
    progress.failure(options.failureNote);
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    try {
      progress.close();
    } finally {
      await options.cleanup();
    }
  }
}
