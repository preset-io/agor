import { BadRequest } from '@agor/core/feathers';
import type { Link } from '@agor/core/types';

export const LINK_TRANSFER_ERROR = {
  fileLifetime: 'File-backed links cannot move until file lifetime is defined',
  internalAccess: 'Internal links cannot move until target access checks are enforced',
  missingTarget: 'Source link has no trusted target to move',
} as const;

export interface LinkTransferErrorCopy {
  fileLifetime: string;
  internalAccess: string;
  missingTarget: string;
}

export type TrustedTransferTarget =
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
      target_object_type: Link['target_object_type'];
      target_object_id: Link['target_object_id'];
    };

export function getTrustedTransferTarget(
  source: Link,
  errorCopy: LinkTransferErrorCopy = LINK_TRANSFER_ERROR
): TrustedTransferTarget {
  if (source.source === 'upload' || source.file_path) {
    throw new BadRequest(errorCopy.fileLifetime);
  }
  if (source.kind === 'internal' || source.target_object_type || source.target_object_id) {
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
  if (source.kind === 'kb_ref' && source.ref_uri) {
    return {
      url: null,
      ref_uri: source.ref_uri,
      file_path: null,
      target_object_type: null,
      target_object_id: null,
    };
  }
  throw new BadRequest(errorCopy.missingTarget);
}
