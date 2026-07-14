import { BadRequest } from '@agor/core/feathers';
import type { Link } from '@agor/core/types';

export const LINK_PROMOTION_ERROR = {
  internalAccess: 'Internal links cannot be promoted until target access checks are enforced',
  missingTarget: 'Source link has no trusted target to promote',
} as const;

const LINK_KIND = {
  internal: 'internal',
  knowledge: 'kb_ref',
} as const;
const LINK_SOURCE = {
  upload: 'upload',
} as const;

export interface LinkPromotionErrorCopy {
  internalAccess: string;
  missingTarget: string;
}

export type PromotableLinkTarget =
  | {
      url: string;
      ref_uri: null;
      file_path: null;
      target_object_type: null;
      target_object_id: null;
    }
  | {
      url: null;
      ref_uri: string;
      file_path: null;
      target_object_type: null;
      target_object_id: null;
    }
  | {
      url: null;
      ref_uri: null;
      file_path: string;
      target_object_type: null;
      target_object_id: null;
    };

export function getPromotableLinkTarget(
  source: Link,
  errorCopy: LinkPromotionErrorCopy = LINK_PROMOTION_ERROR
): PromotableLinkTarget {
  if (source.kind === LINK_KIND.internal || source.target_object_type || source.target_object_id) {
    throw new BadRequest(errorCopy.internalAccess);
  }
  if (source.url) {
    return {
      url: source.url,
      ref_uri: null,
      file_path: null,
      target_object_type: null,
      target_object_id: null,
    };
  }
  if (source.kind === LINK_KIND.knowledge && source.ref_uri) {
    return {
      url: null,
      ref_uri: source.ref_uri,
      file_path: null,
      target_object_type: null,
      target_object_id: null,
    };
  }
  if (source.source === LINK_SOURCE.upload && source.file_path) {
    return {
      url: null,
      ref_uri: null,
      file_path: source.file_path,
      target_object_type: null,
      target_object_id: null,
    };
  }
  throw new BadRequest(errorCopy.missingTarget);
}
