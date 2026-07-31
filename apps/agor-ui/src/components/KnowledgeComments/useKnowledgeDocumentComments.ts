import type { AgorClient, KnowledgeDocumentComment } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useState } from 'react';

const SERVICE_PATH = 'kb/document-comments';

// `toggleReaction` is wired onto the client proxy by `createAgorClient`.
type CommentsClientService = ReturnType<AgorClient['service']> & {
  toggleReaction(data: { comment_id: string; emoji: string }): Promise<KnowledgeDocumentComment>;
};

export interface KnowledgeCommentAnchorInput {
  anchor_slug: string | null;
  anchor_label: string | null;
}

export interface KnowledgeDocumentCommentsApi {
  comments: KnowledgeDocumentComment[];
  loading: boolean;
  error: string | null;
  addComment: (content: string, anchor: KnowledgeCommentAnchorInput) => Promise<void>;
  replyToComment: (parentCommentId: string, content: string) => Promise<void>;
  toggleResolved: (commentId: string) => Promise<void>;
  toggleReaction: (commentId: string, emoji: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
}

/**
 * Loads and live-syncs the comment threads of a single Knowledge document.
 *
 * Comments are fetched per open document rather than hydrated into the global
 * store: a reader only ever needs the document in front of them, and the
 * service refuses unscoped listing.
 */
export function useKnowledgeDocumentComments(
  client: AgorClient | null,
  documentId: string | null
): KnowledgeDocumentCommentsApi {
  const [comments, setComments] = useState<KnowledgeDocumentComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !documentId) {
      setComments([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .service(SERVICE_PATH)
      .find({ query: { document_id: documentId } })
      .then((result: KnowledgeDocumentComment[] | { data?: KnowledgeDocumentComment[] }) => {
        if (cancelled) return;
        setComments(Array.isArray(result) ? result : (result.data ?? []));
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        setComments([]);
        setError(cause.message || 'Failed to load comments');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, documentId]);

  useEffect(() => {
    if (!client || !documentId) return;

    const service = client.service(SERVICE_PATH);
    const isForDocument = (comment: KnowledgeDocumentComment) => comment.document_id === documentId;

    const upsert = (comment: KnowledgeDocumentComment) => {
      if (!isForDocument(comment)) return;
      setComments((prev) => {
        const index = prev.findIndex((c) => c.comment_id === comment.comment_id);
        if (index === -1) return [...prev, comment];
        const next = [...prev];
        next[index] = comment;
        return next;
      });
    };
    const remove = (comment: KnowledgeDocumentComment) => {
      if (!isForDocument(comment)) return;
      setComments((prev) =>
        prev.filter(
          (c) => c.comment_id !== comment.comment_id && c.parent_comment_id !== comment.comment_id
        )
      );
    };

    service.on('created', upsert);
    service.on('patched', upsert);
    service.on('removed', remove);
    return () => {
      service.off('created', upsert);
      service.off('patched', upsert);
      service.off('removed', remove);
    };
  }, [client, documentId]);

  const addComment = useCallback(
    async (content: string, anchor: KnowledgeCommentAnchorInput) => {
      if (!client || !documentId) return;
      await client.service(SERVICE_PATH).create({
        document_id: documentId,
        content,
        anchor_slug: anchor.anchor_slug,
        anchor_label: anchor.anchor_label,
      });
    },
    [client, documentId]
  );

  const replyToComment = useCallback(
    async (parentCommentId: string, content: string) => {
      if (!client) return;
      await client.service(SERVICE_PATH).create({ parent_comment_id: parentCommentId, content });
    },
    [client]
  );

  const toggleResolved = useCallback(
    async (commentId: string) => {
      if (!client) return;
      const current = comments.find((c) => c.comment_id === commentId);
      await client.service(SERVICE_PATH).patch(commentId, { resolved: !current?.resolved });
    },
    [client, comments]
  );

  const toggleReaction = useCallback(
    async (commentId: string, emoji: string) => {
      if (!client) return;
      const service = client.service(SERVICE_PATH) as unknown as CommentsClientService;
      await service.toggleReaction({ comment_id: commentId, emoji });
    },
    [client]
  );

  const deleteComment = useCallback(
    async (commentId: string) => {
      if (!client) return;
      await client.service(SERVICE_PATH).remove(commentId);
    },
    [client]
  );

  return useMemo(
    () => ({
      comments,
      loading,
      error,
      addComment,
      replyToComment,
      toggleResolved,
      toggleReaction,
      deleteComment,
    }),
    [
      comments,
      loading,
      error,
      addComment,
      replyToComment,
      toggleResolved,
      toggleReaction,
      deleteComment,
    ]
  );
}
