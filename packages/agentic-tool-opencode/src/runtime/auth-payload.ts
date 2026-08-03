import { z } from 'zod';

export const OpenCodeAuthParamsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('discover'),
    directory: z.string().min(1).optional(),
  }),
  z.object({
    operation: z.literal('connect-api-key'),
    providerId: z.string().trim().min(1).max(200),
    apiKey: z.string().trim().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    operation: z.literal('disconnect'),
    providerId: z.string().trim().min(1).max(200),
  }),
  z.object({
    operation: z.literal('connect-oauth'),
    providerId: z.string().trim().min(1).max(200),
    method: z.number().int().nonnegative(),
    inputs: z.record(z.string(), z.string()).optional(),
  }),
]);

export interface OpenCodeAuthPayload {
  command: 'opencode.auth';
  dataHome: string;
  params: z.infer<typeof OpenCodeAuthParamsSchema>;
}
