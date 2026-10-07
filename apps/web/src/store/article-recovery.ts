import type { AppDoc, ArticleWorkspaceData } from '../types/document';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return `{${entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameArticle(left: AppDoc, right: AppDoc): boolean {
  return (
    stableJson({ ...left, parentId: left.parentId ?? null }) ===
    stableJson({ ...right, parentId: right.parentId ?? null })
  );
}

/** Import old local drafts, or recover a conflict as copies. Existing cloud
 * articles (including cloud deletions) are never replaced by recovery. */
export function recoverLocalArticles(
  remote: ArticleWorkspaceData,
  local: ArticleWorkspaceData,
  labelCopies = false,
): ArticleWorkspaceData {
  const remoteDocs = new Map(remote.docs.map((doc) => [doc.id, doc]));
  const ids = new Map<string, string>();
  for (const doc of local.docs) {
    const existing = remoteDocs.get(doc.id);
    ids.set(doc.id, existing && !sameArticle(existing, doc) ? crypto.randomUUID() : doc.id);
  }
  // If a parent's ID changes, descendants must be copied as well to preserve
  // the imported tree instead of moving the existing remote descendants.
  let changed = true;
  while (changed) {
    changed = false;
    for (const doc of local.docs) {
      if (
        doc.parentId &&
        ids.get(doc.parentId) !== doc.parentId &&
        ids.get(doc.id) === doc.id &&
        remoteDocs.has(doc.id)
      ) {
        ids.set(doc.id, crypto.randomUUID());
        changed = true;
      }
    }
  }
  const imported = local.docs
    .filter((doc) => !remoteDocs.has(ids.get(doc.id)!))
    .map((doc) => ({
      ...doc,
      id: ids.get(doc.id)!,
      parentId: doc.parentId ? (ids.get(doc.parentId) ?? doc.parentId) : null,
      title:
        labelCopies && remoteDocs.has(doc.id)
          ? `${doc.title || '无标题'}（恢复的草稿）`
          : doc.title,
    }));
  const docs = [...imported, ...remote.docs];
  const importedRecords = local.publishRecords
    .filter(
      (record) =>
        !remote.publishRecords.some((existing) => existing.publishId === record.publishId),
    )
    .map((record) => ({ ...record, docId: ids.get(record.docId) ?? record.docId }));
  const selected = ids.get(local.currentDocId) ?? remote.currentDocId;
  return {
    docs,
    currentDocId: docs.some((doc) => doc.id === selected && !doc.deletedAt)
      ? selected
      : (docs.find((doc) => !doc.deletedAt)?.id ?? ''),
    publishRecords: [...importedRecords, ...remote.publishRecords],
  };
}
