import type { AgorClient, KnowledgeDocument } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';

const KNOWLEDGE_DOCUMENT_LIMIT = 100;

function normalizeFindResult<T>(result: T[] | { data?: T[] }): T[] {
  return Array.isArray(result) ? result : (result.data ?? []);
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

export function useKnowledgeDocumentsById(
  client: AgorClient | null | undefined,
  documentIds: readonly string[]
): Map<string, KnowledgeDocument> {
  const idsKey = uniqueIds(documentIds).sort().join(',');
  const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey]);
  const [documentsById, setDocumentsById] = useState<Map<string, KnowledgeDocument>>(new Map());

  useEffect(() => {
    if (!client || ids.length === 0) {
      setDocumentsById(new Map());
      return;
    }

    let cancelled = false;
    const service = client.service('kb/documents');

    const load = async () => {
      const results = await Promise.allSettled(ids.map((id) => service.get(id)));
      if (cancelled) return;
      const next = new Map<string, KnowledgeDocument>();
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const document = result.value as KnowledgeDocument;
          next.set(document.document_id, document);
        }
      }
      setDocumentsById(next);
    };

    const handleChanged = (document: KnowledgeDocument) => {
      if (!ids.includes(document.document_id)) return;
      void load();
    };

    void load();
    service.on?.('created', handleChanged);
    service.on?.('updated', handleChanged);
    service.on?.('patched', handleChanged);
    service.on?.('removed', handleChanged);
    return () => {
      cancelled = true;
      service.off?.('created', handleChanged);
      service.off?.('updated', handleChanged);
      service.off?.('patched', handleChanged);
      service.off?.('removed', handleChanged);
    };
  }, [client, ids]);

  return documentsById;
}

export function useReadableKnowledgeDocuments(
  client: AgorClient | null | undefined,
  enabled = true
): KnowledgeDocument[] {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);

  useEffect(() => {
    if (!client || !enabled) {
      setDocuments([]);
      return;
    }

    let cancelled = false;
    const service = client.service('kb/documents');
    const load = async () => {
      try {
        const result = await service.find({
          query: { archived: false, $limit: KNOWLEDGE_DOCUMENT_LIMIT, $sort: { title: 1 } },
        });
        if (!cancelled) {
          setDocuments(normalizeFindResult<KnowledgeDocument>(result));
        }
      } catch {
        if (!cancelled) setDocuments([]);
      }
    };

    const handleChanged = () => void load();
    void load();
    service.on?.('created', handleChanged);
    service.on?.('updated', handleChanged);
    service.on?.('patched', handleChanged);
    service.on?.('removed', handleChanged);
    return () => {
      cancelled = true;
      service.off?.('created', handleChanged);
      service.off?.('updated', handleChanged);
      service.off?.('patched', handleChanged);
      service.off?.('removed', handleChanged);
    };
  }, [client, enabled]);

  return documents;
}
