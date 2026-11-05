import { ZONE_PLACEMENT_ANCHORS } from '@agor/core/types';
import { z } from 'zod';

export const mcpPlacement = z
  .union([
    z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    z.enum(ZONE_PLACEMENT_ANCHORS),
  ])
  .describe(
    'Position: {x,y} relative to the zone top-left, or a named anchor using adaptive padding. Coordinates are clamped to zone bounds accounting for entity size. Without a zone, only absolute {x,y} is supported. Omit for random zone placement.'
  );
