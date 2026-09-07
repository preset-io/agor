import { z } from 'zod';

/** Shared executor/daemon result contract, also safe to use at browser rendering boundaries. */
export const environmentAccessUrlSchema = z
  .object({
    name: z.string().min(1).max(128),
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        if (!/^https?:\/\//i.test(value)) return false;
        try {
          const url = new URL(value);
          return !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'Access URLs must be absolute credential-free HTTP(S) URLs'),
  })
  .strict();

export const environmentAccessUrlsSchema = z.array(environmentAccessUrlSchema).max(8);
