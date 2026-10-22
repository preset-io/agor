import { type CollisionDetection, closestCenter } from '@dnd-kit/core';
import type { RefObject } from 'react';

/**
 * `closestCenter`, but only while the pointer is inside `region`. A drop
 * outside it has no target, so dnd-kit cancels: the order snaps back and
 * nothing is saved.
 */
export const closestCenterWithin =
  (region: RefObject<HTMLElement | null>): CollisionDetection =>
  (args) => {
    const rect = region.current?.getBoundingClientRect();
    const pointer = args.pointerCoordinates;
    if (
      !rect ||
      !pointer ||
      pointer.x < rect.left ||
      pointer.x > rect.right ||
      pointer.y < rect.top ||
      pointer.y > rect.bottom
    ) {
      return [];
    }
    return closestCenter(args);
  };
