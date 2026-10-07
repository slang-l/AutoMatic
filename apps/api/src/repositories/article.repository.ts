import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import type { ArticleWorkspace, SaveArticleWorkspace } from '../type/article.js';

export interface ArticleRepository {
  getWorkspace(userId: string): Promise<ArticleWorkspace>;
  saveWorkspace(userId: string, input: SaveArticleWorkspace): Promise<{ revision: number }>;
}

export function workspaceWriteHash(input: SaveArticleWorkspace): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

// A conditional write plus a retry ID protects against lost updates from other
// tabs/devices and against duplicate writes after a lost HTTP response.
export function checkWorkspaceWrite(
  row: { revision: number; writeId: string | null; writeHash: string | null },
  input: SaveArticleWorkspace,
  hash: string,
): 'retry' | 'write' {
  if (row.writeId === input.writeId) {
    if (row.writeHash !== hash) {
      throw new AppError(
        409,
        'ARTICLE_WRITE_CONFLICT',
        'Write ID was reused with different content',
      );
    }
    return 'retry';
  }
  if (row.revision !== input.revision) {
    throw new AppError(
      409,
      'ARTICLE_REVISION_CONFLICT',
      'Articles changed in another tab or device',
    );
  }
  return 'write';
}
