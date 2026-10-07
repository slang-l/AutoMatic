import type { ArticleRepository } from './article.repository.js';
import { checkWorkspaceWrite, workspaceWriteHash } from './article.repository.js';
import { emptyArticleWorkspace, type ArticleWorkspace } from '../type/article.js';

export function createMemoryArticleRepository(): ArticleRepository {
  const workspaces = new Map<
    string,
    {
      workspace: ArticleWorkspace;
      writeId: string;
      writeHash: string;
    }
  >();
  return {
    async getWorkspace(userId) {
      return structuredClone(workspaces.get(userId)?.workspace ?? emptyArticleWorkspace());
    },
    async saveWorkspace(userId, input) {
      const current = workspaces.get(userId);
      const hash = workspaceWriteHash(input);
      const row = {
        revision: current?.workspace.revision ?? 0,
        writeId: current?.writeId ?? null,
        writeHash: current?.writeHash ?? null,
      };
      if (checkWorkspaceWrite(row, input, hash) === 'retry') return { revision: row.revision };
      const { writeId, ...workspace } = structuredClone(input);
      workspace.revision++;
      workspaces.set(userId, { workspace, writeId, writeHash: hash });
      return { revision: workspace.revision };
    },
  };
}
