export type FileChangeKind = 'add' | 'update' | 'delete';

export const fileChangeKindToOperationType = (
  kind: FileChangeKind
): 'edit' | 'create' | 'delete' => {
  switch (kind) {
    case 'add':
      return 'create';
    case 'delete':
      return 'delete';
    default:
      return 'edit';
  }
};

export const fileChangeKindLabel = (kind: FileChangeKind): string => {
  switch (kind) {
    case 'add':
      return 'Create';
    case 'delete':
      return 'Delete';
    default:
      return 'Update';
  }
};
