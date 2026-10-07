import { AppError } from '../errors.js';
import type { ArticleRepository } from '../repositories/article.repository.js';
import type { SaveArticleWorkspace } from '../type/article.js';

export function createArticleService(repository: ArticleRepository) {
  return {
    getWorkspace: (userId: string) => repository.getWorkspace(userId),
    saveWorkspace(userId: string, input: SaveArticleWorkspace) {
      const byId = new Map(input.docs.map((doc) => [doc.id, doc]));
      const invalid = () => {
        throw new AppError(
          400,
          'INVALID_ARTICLE_WORKSPACE',
          'Invalid article hierarchy or selection',
        );
      };
      if (byId.size !== input.docs.length) invalid();
      // Iterative traversal with memoization also rejects cycles without
      // overflowing the stack on deeply nested imported workspaces.
      const visited = new Set<string>();
      for (const doc of input.docs) {
        const path = new Set<string>();
        let current: typeof doc | undefined = doc;
        while (current && !visited.has(current.id)) {
          if (path.has(current.id)) invalid();
          path.add(current.id);
          if (current.parentId) {
            const parent = byId.get(current.parentId);
            if (!parent || (!current.deletedAt && parent.deletedAt)) invalid();
            current = parent;
          } else current = undefined;
        }
        for (const id of path) visited.add(id);
      }
      const selected = byId.get(input.currentDocId);
      if (
        input.currentDocId
          ? !selected || selected.deletedAt
          : input.docs.some((doc) => !doc.deletedAt)
      )
        invalid();
      if (
        new Set(input.publishRecords.map((record) => record.publishId)).size !==
        input.publishRecords.length
      )
        invalid();
      return repository.saveWorkspace(userId, input);
    },
  };
}

export type ArticleService = ReturnType<typeof createArticleService>;
