import { z } from 'zod';

/** Private daemon/executor request-response protocol. */
export const EXECUTOR_RESPONSE_PROTOCOL = 'executor-response-v1' as const;
export const EXECUTOR_RESPONSE_CONTENT_TYPE = 'application/x-ndjson' as const;
export const EXECUTOR_RESPONSE_PROTOCOL_HEADER = 'x-agor-executor-response-protocol' as const;
export const EXECUTOR_RESPONSE_MAX_EVENT_BYTES = 64 * 1024;
export const EXECUTOR_RESPONSE_MAX_EVENTS = 8;

export const EXECUTOR_RESPONSE_TOO_LARGE = 'EXECUTOR_RESPONSE_TOO_LARGE' as const;

/**
 * One-attempt response capability passed to an executor in its JSON stdin
 * payload. The request ID is correlation only; the bearer token is the
 * authority. Neither value is a tenant or resource identifier.
 */
export const ExecutorResponseDescriptorSchema = z
  .object({
    protocol: z.literal(EXECUTOR_RESPONSE_PROTOCOL),
    profile: z.enum(['terminal', 'events']),
    requestId: z.string().uuid(),
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
        message: 'Executor response URL must use HTTP(S)',
      }),
    token: z.string().min(32).max(512),
    deadlineAt: z.string().datetime(),
    maxResponseBytes: z.number().int().positive(),
  })
  .strict();

export type ExecutorResponseDescriptor = z.infer<typeof ExecutorResponseDescriptorSchema>;

export const ExecutorCommandResultSchema = z
  .object({
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ExecutorCommandResult = z.infer<typeof ExecutorCommandResultSchema>;

export const ExecutorResponseEventNameSchema = z.enum(['authorized', 'callback-started']);

export const ExecutorResponseEventFrameSchema = z
  .object({
    v: z.literal(1),
    requestId: z.string().uuid(),
    type: z.literal('event'),
    seq: z.number().int().nonnegative(),
    name: ExecutorResponseEventNameSchema,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ExecutorResponseFinalFrameSchema = z
  .object({
    v: z.literal(1),
    requestId: z.string().uuid(),
    type: z.literal('final'),
    seq: z.number().int().nonnegative(),
    result: ExecutorCommandResultSchema,
  })
  .strict();

export const ExecutorResponseFrameSchema = z.discriminatedUnion('type', [
  ExecutorResponseEventFrameSchema,
  ExecutorResponseFinalFrameSchema,
]);

export type ExecutorResponseFrame = z.infer<typeof ExecutorResponseFrameSchema>;
