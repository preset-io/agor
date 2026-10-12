import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  encodeKnowledgeDocument,
  exportRepositoryLinks,
  knowledgeRepositoryFiles,
  serializeKnowledgeYaml,
} from '@agor/core/knowledge';
import { KNOWLEDGE_REPOSITORY, type KnowledgeTransferManifest } from '@agor/core/types';

/** Disposable synthetic v2 fixtures shared by CLI and real daemon HTTP tests. */
export async function writeRepositoryFixture(
  directory: string,
  manifest: KnowledgeTransferManifest,
  body: string
) {
  const files = knowledgeRepositoryFiles(manifest.documents.map((doc) => doc.path));
  await writeFile(
    join(directory, 'manifest.yaml'),
    serializeKnowledgeYaml({
      format: manifest.format,
      version: 2,
      namespace: manifest.namespace,
      documents: [...files.values()].sort(),
      omissions: manifest.omissions,
    })
  );
  for (const [index, entry] of manifest.documents.entries()) {
    const file = files.get(entry.path)!;
    await mkdir(dirname(join(directory, file)), { recursive: true, mode: 0o700 });
    const {
      key: _key,
      sha256: _sha,
      bytes: _bytes,
      frontmatter,
      provenance,
      ...attributes
    } = entry;
    await writeFile(
      join(directory, file),
      encodeKnowledgeDocument(
        {
          format: KNOWLEDGE_REPOSITORY.documentFormat,
          version: 2,
          agor: {
            id: String(
              provenance.source_uuid ??
                `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
            ),
            ...attributes,
          },
          frontmatter,
          provenance,
        },
        exportRepositoryLinks(body, manifest, files, file).content
      )
    );
  }
  return files;
}
